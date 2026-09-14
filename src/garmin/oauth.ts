/**
 * OAuth 1.0a HMAC-SHA1 签名模块
 *
 * 使用 Web Crypto 实现（无 Node 原生模块依赖），
 * 因此 Node >=20 与 Cloudflare Workers 均可直接运行。
 *
 * 行为精确对齐 oauth-1.0a 的默认配置：
 *   nonce_length=32, version='1.0', parameter_seperator=', ', last_ampersand=true,
 *   signature_method='HMAC-SHA1'
 */

export interface OAuthConsumer {
  key: string;
  secret: string;
}

export interface OAuthToken {
  key: string;
  secret?: string;
}

export interface OAuthRequest {
  url: string;
  method: string;
  /** 参与签名的额外参数（表单体） */
  data?: Record<string, string | number | boolean | null> | null;
}

export interface OAuthData {
  oauth_consumer_key: string;
  oauth_nonce: string;
  oauth_signature_method: string;
  oauth_timestamp: number;
  oauth_version: string;
  oauth_token?: string;
  oauth_signature: string;
}

const NONCE_LENGTH = 32;
const NONCE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SIGNATURE_METHOD = 'HMAC-SHA1';
const PARAM_SEPARATOR = ', ';

const textEncoder = new TextEncoder();

/**
 * RFC 5849 percent-encoding：encodeURIComponent 后再编码 !*'()
 */
export function percentEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

/**
 * 解析 querystring 为对象（按首个 = 切分，保留值中的 = 与编码内容）
 */
function deParam(query: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!query) return result;
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    const rawKey = idx === -1 ? pair : pair.slice(0, idx);
    const rawValue = idx === -1 ? '' : pair.slice(idx + 1);
    result[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
  }
  return result;
}

function deParamUrl(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  return idx === -1 ? {} : deParam(url.slice(idx + 1));
}

/**
 * Parameter String：合并 url query + request.data + oauth_data，
 * 对 key/value 做 percentEncode，按 key 排序后拼接为 k=v&k=v
 */
function getParameterString(request: OAuthRequest, oauthData: Record<string, string | number>): string {
  const merged: Record<string, string> = {};
  const add = (key: string, value: string): void => {
    merged[percentEncode(key)] = percentEncode(value);
  };

  for (const [key, value] of Object.entries(oauthData)) add(key, String(value));
  for (const [key, value] of Object.entries(request.data ?? {})) add(key, String(value));
  for (const [key, value] of Object.entries(deParamUrl(request.url))) add(key, value);

  return Object.keys(merged)
    .sort()
    .map((key) => `${key}=${merged[key]}`)
    .join('&');
}

function getBaseString(request: OAuthRequest, oauthData: Record<string, string | number>): string {
  const baseUrl = request.url.split('?')[0];
  return `${request.method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(
    getParameterString(request, oauthData),
  )}`;
}

function getSigningKey(consumerSecret: string, tokenSecret?: string): string {
  return `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret ?? '')}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function hmacSha1(baseString: string, signingKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(signingKey),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(baseString));
  return toBase64(new Uint8Array(signature));
}

function generateNonce(): string {
  const bytes = new Uint8Array(NONCE_LENGTH);
  crypto.getRandomValues(bytes);
  let nonce = '';
  for (let i = 0; i < NONCE_LENGTH; i += 1) {
    nonce += NONCE_CHARS[bytes[i] % NONCE_CHARS.length];
  }
  return nonce;
}

export class OAuth1Client {
  private readonly consumer: OAuthConsumer;

  constructor(consumer: OAuthConsumer) {
    this.consumer = consumer;
  }

  /**
   * 生成完整的 OAuth 授权参数（含 oauth_signature）
   */
  async authorize(request: OAuthRequest, token?: OAuthToken): Promise<OAuthData> {
    const oauthData: Record<string, string | number> = {
      oauth_consumer_key: this.consumer.key,
      oauth_nonce: generateNonce(),
      oauth_signature_method: SIGNATURE_METHOD,
      oauth_timestamp: Math.floor(Date.now() / 1000),
      oauth_version: '1.0',
    };

    if (token?.key !== undefined) {
      oauthData.oauth_token = token.key;
    }

    const baseString = getBaseString(request, oauthData);
    oauthData.oauth_signature = await hmacSha1(
      baseString,
      getSigningKey(this.consumer.secret, token?.secret),
    );

    return oauthData as unknown as OAuthData;
  }

  /**
   * 将授权参数序列化为 Authorization 头
   */
  async authHeader(request: OAuthRequest, token?: OAuthToken): Promise<string> {
    const oauthData = await this.authorize(request, token);
    return toHeader(oauthData);
  }
}

/**
 * oauth_data -> `OAuth k="v", k="v"`（按 key 排序，仅保留 oauth_ 前缀字段）
 */
export function toHeader(oauthData: OAuthData): string {
  const parts = Object.keys(oauthData)
    .sort()
    .filter((key) => key.startsWith('oauth_'))
    .map(
      (key) =>
        `${percentEncode(key)}="${percentEncode(String(oauthData[key as keyof OAuthData]))}"`,
    );
  return `OAuth ${parts.join(PARAM_SEPARATOR)}`;
}
