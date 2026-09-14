/**
 * Garmin Connect 认证模块（纯 HTTP，无浏览器依赖）
 *
 * 完整复刻 garmin-connect 的认证链：
 *   1. 拉取 OAuth consumer（公共凭据）
 *   2. SSO 三步拿到 login ticket
 *   3. ticket 换 OAuth1 token（HMAC-SHA1 签名）
 *   4. OAuth1 换 OAuth2 token（HMAC-SHA1 签名）
 *
 * 仅依赖 fetch + Web Crypto，Node >=20 与 Cloudflare Workers 通用。
 */

import { OAuth1Client, type OAuthConsumer, type OAuthToken } from './oauth.js';
import {
  GC_API,
  GC_MODERN,
  GARMIN_SSO_ORIGIN,
  OAUTH_CONSUMER_URL,
  OAUTH_URL,
  SSO_EMBED_URL,
  SSO_SIGNIN_URL,
  USER_AGENT_BROWSER,
  USER_AGENT_CONNECTMOBILE,
  ENDPOINTS,
} from './endpoints.js';

const CSRF_RE = /name="_csrf"\s+value="(.+?)"/;
const TICKET_RE = /ticket=([^"]+)"/;
const ACCOUNT_LOCKED_RE = /var status\s*=\s*"([^"]*)"/;
const PAGE_TITLE_RE = /<title>([^<]*)<\/title>/;

/** OAuth2 令牌响应 */
export interface GarminOAuth2Token {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  refresh_token_expires_in: number;
  scope?: string;
}

/** 用户资料 */
interface SocialProfile {
  displayName?: string;
  userName?: string;
  fullName?: string;
}

/** Garmin 认证错误 */
export class GarminAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GarminAuthError';
  }
}

/** qs.stringify 的轻量等价实现（RFC3986 percent-encoding） */
function queryStringify(params: Record<string, string | number | boolean>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

/** querystring 解析 */
function parseQuery(str: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of str.split('&')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    const key = decodeURIComponent(idx === -1 ? pair : pair.slice(0, idx));
    const value = idx === -1 ? '' : decodeURIComponent(pair.slice(idx + 1));
    result[key] = value;
  }
  return result;
}

export class GarminAuth {
  private consumer: OAuthConsumer | null = null;
  private oauth1: OAuthToken | null = null;
  private oauth2: GarminOAuth2Token | null = null;
  private displayName: string | null = null;
  private oauthClient: OAuth1Client | null = null;

  constructor(
    private readonly log: (message: string) => void = () => {},
  ) {}

  /**
   * 账号密码登录，完成后可调用 getAccessToken()
   */
  async login(username: string, password: string): Promise<GarminOAuth2Token> {
    if (!username || !password) {
      throw new GarminAuthError('缺少 Garmin 账号或密码');
    }

    this.log('[auth] 获取 OAuth consumer');
    await this.fetchOauthConsumer();

    this.log('[auth] SSO 登录获取 ticket');
    const ticket = await this.getLoginTicket(username, password);

    this.log('[auth] ticket 换取 OAuth1 token');
    await this.getOauth1Token(ticket);

    this.log('[auth] OAuth1 换取 OAuth2 token');
    const token = await this.exchange();
    this.log('[auth] 登录成功');
    return token;
  }

  /**
   * 使用缓存的长效 OAuth1 token 直接换取 OAuth2（跳过 SSO 账号密码登录）
   *
   * sso.garmin.com 前置的 Cloudflare 会拦截云机房 IP（如 GitHub Actions），
   * 而 exchange 接口位于 connectapi.garmin.com，不受影响。
   * token 通过本机执行 `npm run token` 登录一次获得。
   */
  async loginWithOauth1(token: OAuthToken): Promise<GarminOAuth2Token> {
    if (!token?.key) {
      throw new GarminAuthError('缺少 OAuth1 token');
    }

    this.log('[auth] 使用缓存 OAuth1 token 登录（跳过 SSO）');
    await this.fetchOauthConsumer();
    this.oauth1 = { key: token.key, secret: token.secret };

    const oauth2 = await this.exchange();
    this.log('[auth] 登录成功');
    return oauth2;
  }

  /**
   * 取出当前 OAuth1 token（引导脚本用于生成 CI secrets）
   */
  getOAuth1Token(): OAuthToken {
    if (!this.oauth1?.key) {
      throw new GarminAuthError('尚未通过 SSO 登录，OAuth1 token 不存在');
    }
    return { key: this.oauth1.key, secret: this.oauth1.secret };
  }

  /**
   * 使用已有 OAuth2 令牌（避免每次都走 SSO 登录）
   */
  useToken(token: GarminOAuth2Token): void {
    this.oauth2 = token;
  }

  getAccessToken(): string {
    if (!this.oauth2?.access_token) {
      throw new GarminAuthError('尚未登录，access_token 不存在');
    }
    return this.oauth2.access_token;
  }

  getOAuth2Token(): GarminOAuth2Token {
    if (!this.oauth2) {
      throw new GarminAuthError('尚未登录');
    }
    return this.oauth2;
  }

  getDisplayName(): string {
    if (!this.displayName) {
      throw new GarminAuthError('displayName 未获取，请先调用 getProfile()');
    }
    return this.displayName;
  }

  /**
   * 拉取用户资料并缓存 displayName
   */
  async getProfile(): Promise<string> {
    const profile = await this.request<SocialProfile>(ENDPOINTS.socialProfile);
    const name = profile.displayName ?? profile.userName;
    if (!name) {
      throw new GarminAuthError('socialProfile 未返回 displayName');
    }
    this.displayName = name;
    return name;
  }

  /**
   * 带 Bearer 令牌的 API 请求
   */
  async request<T>(path: string): Promise<T> {
    const response = await fetch(`${GC_API}${path}`, {
      headers: {
        Authorization: `Bearer ${this.getAccessToken()}`,
        Accept: 'application/json',
        'User-Agent': USER_AGENT_CONNECTMOBILE,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new GarminAuthError(
        `Garmin API 请求失败 (${response.status}) ${path}: ${body.slice(0, 200)}`,
      );
    }

    return (await response.json()) as T;
  }

  /** 拉取公共 OAuth consumer 凭据 */
  private async fetchOauthConsumer(): Promise<void> {
    const response = await fetch(OAUTH_CONSUMER_URL);
    if (!response.ok) {
      throw new GarminAuthError(`获取 OAuth consumer 失败 (${response.status})`);
    }
    const data = (await response.json()) as { consumer_key: string; consumer_secret: string };
    this.consumer = { key: data.consumer_key, secret: data.consumer_secret };
    this.oauthClient = new OAuth1Client(this.consumer);
  }

  private getClient(): OAuth1Client {
    if (!this.oauthClient) {
      throw new GarminAuthError('OAuth client 未初始化，请先调用 login()');
    }
    return this.oauthClient;
  }

  /**
   * SSO 三步登录，返回 login ticket
   */
  private async getLoginTicket(username: string, password: string): Promise<string> {
    // step 1: 初始化 SSO 会话
    const step1Url = `${SSO_EMBED_URL}?${queryStringify({
      clientId: 'GarminConnect',
      locale: 'en',
      service: GC_MODERN,
    })}`;
    await fetch(step1Url);

    // step 2: 取登录页，提取 CSRF
    const step2Url = `${SSO_SIGNIN_URL}?${queryStringify({
      id: 'gauth-widget',
      embedWidget: true,
      locale: 'en',
      gauthHost: SSO_EMBED_URL,
    })}`;
    const step2Response = await fetch(step2Url);
    const step2Html = await step2Response.text();
    const csrfMatch = CSRF_RE.exec(step2Html);
    if (!csrfMatch) {
      throw new GarminAuthError('SSO 登录失败：未找到 _csrf token');
    }

    // step 3: 提交账号密码，提取 ticket
    const step3Url = `${SSO_SIGNIN_URL}?${queryStringify({
      id: 'gauth-widget',
      embedWidget: true,
      clientId: 'GarminConnect',
      locale: 'en',
      gauthHost: SSO_EMBED_URL,
      service: SSO_EMBED_URL,
      source: SSO_EMBED_URL,
      redirectAfterAccountLoginUrl: SSO_EMBED_URL,
      redirectAfterAccountCreationUrl: SSO_EMBED_URL,
    })}`;

    const step3Response = await fetch(step3Url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Dnt: '1',
        Origin: GARMIN_SSO_ORIGIN,
        Referer: SSO_SIGNIN_URL,
        'User-Agent': USER_AGENT_BROWSER,
      },
      body: queryStringify({
        username,
        password,
        embed: 'true',
        _csrf: csrfMatch[1],
      }),
    });
    const step3Html = await step3Response.text();

    if (step3Response.status === 429) {
      throw new GarminAuthError(
        'SSO 登录被 Cloudflare 限流（HTTP 429），请等待一段时间后重试，避免短时间内反复登录',
      );
    }

    const lockedMatch = ACCOUNT_LOCKED_RE.exec(step3Html);
    if (lockedMatch) {
      throw new GarminAuthError(`SSO 登录失败：账号被锁定（${lockedMatch[1]}），请先在网页端解锁`);
    }

    const titleMatch = PAGE_TITLE_RE.exec(step3Html);
    if (titleMatch && titleMatch[1].includes('Update Phone Number')) {
      throw new GarminAuthError('SSO 登录失败：账号需要先更新手机号');
    }

    const ticketMatch = TICKET_RE.exec(step3Html);
    if (!ticketMatch) {
      throw new GarminAuthError('SSO 登录失败：未拿到 ticket，请检查账号密码或是否开启了两步验证');
    }
    return ticketMatch[1];
  }

  /**
   * 用 ticket 换 OAuth1 token
   */
  private async getOauth1Token(ticket: string): Promise<void> {
    const url = `${OAUTH_URL}/preauthorized?${queryStringify({
      ticket,
      'login-url': SSO_EMBED_URL,
      'accepts-mfa-tokens': true,
    })}`;

    const authorization = await this.getClient().authHeader({ url, method: 'GET' });
    const response = await fetch(url, {
      headers: {
        Authorization: authorization,
        'User-Agent': USER_AGENT_CONNECTMOBILE,
      },
    });

    if (!response.ok) {
      throw new GarminAuthError(`换取 OAuth1 token 失败 (${response.status})`);
    }

    const parsed = parseQuery(await response.text());
    if (!parsed.oauth_token || !parsed.oauth_token_secret) {
      throw new GarminAuthError('OAuth1 token 响应缺少 oauth_token / oauth_token_secret');
    }
    this.oauth1 = { key: parsed.oauth_token, secret: parsed.oauth_token_secret };
  }

  /**
   * OAuth1 换 OAuth2 token
   */
  private async exchange(): Promise<GarminOAuth2Token> {
    if (!this.oauth1) {
      throw new GarminAuthError('OAuth1 token 不存在，无法换取 OAuth2 token');
    }

    const baseUrl = `${OAUTH_URL}/exchange/user/2.0`;
    const oauthData = await this.getClient().authorize({ url: baseUrl, method: 'POST' }, this.oauth1);
    const url = `${baseUrl}?${queryStringify(
      oauthData as unknown as Record<string, string | number>,
    )}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT_CONNECTMOBILE,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new GarminAuthError(`换取 OAuth2 token 失败 (${response.status}): ${body.slice(0, 200)}`);
    }

    const token = (await response.json()) as GarminOAuth2Token;
    if (!token.access_token) {
      throw new GarminAuthError('OAuth2 token 响应缺少 access_token');
    }
    this.oauth2 = token;
    return token;
  }
}
