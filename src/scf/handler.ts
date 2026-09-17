/**
 * 腾讯云函数 SCF 入口（事件函数，Node.js 18/20）
 *
 * 用途：workers.dev 在大陆无法访问，企业微信回调改由 SCF 承接，
 * 函数 URL / API 网关触发器自带国内可直连的 HTTPS 地址。
 *
 * 与 Cloudflare Worker 版本的差异：
 * - SCF 事件函数在 handler 返回后会冻结实例，没有 waitUntil 语义，
 *   因此 POST 分支必须「同步」完成对话 + 主动消息推送，再返回 success。
 *   DeepSeek + Garmin 热路径通常 2~5 秒，在企业微信 5 秒窗口内；
 *   超时重试由 MsgId 去重（同实例）兜底。
 * - 事件/响应采用 API 网关代理集成格式（函数 URL 同构）。
 *
 * 复用：src/wecom/*（crypto/chat/api）与 src/garmin/*，业务逻辑零分叉。
 */

import { verifySignature, decryptMessage, buildPassiveReplyXml, buildTextReplyBodyXml } from '../wecom/crypto.js';
import { handleUserMessage } from '../wecom/chat.js';
import { extractCData, shouldProcess } from '../wecom/callback.js';
import type { WecomChatEnv } from '../wecom/types.js';
import { parseWeightPayload } from '../health/weight.js';
import { putWeightToCos } from '../health/cos-writer.js';

/** SCF 环境变量：在 WecomChatEnv 基础上增加体重 webhook 所需 COS 配置 */
interface ScfEnv extends WecomChatEnv {
  /** 腾讯云 SecretId（用于 COS 写入签名） */
  COS_SECRET_ID?: string;
  /** 腾讯云 SecretKey */
  COS_SECRET_KEY?: string;
  /** COS bucket 名（含 APPID 后缀） */
  COS_BUCKET?: string;
  /** COS 区域，如 ap-shanghai */
  COS_REGION?: string;
}

/** API 网关代理事件 / 函数 URL 事件（字段名两种形态都兼容） */
export interface ScfEvent {
  httpMethod?: string;
  method?: string;
  path?: string;
  rawPath?: string;
  queryString?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface ScfContext {
  request_id?: string;
  [key: string]: unknown;
}

export interface ScfResult {
  isBase64Encoded: boolean;
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function jsonResult(statusCode: number, obj: unknown): ScfResult {
  return {
    isBase64Encoded: false,
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj),
  };
}

function textResult(statusCode: number, text: string): ScfResult {
  return {
    isBase64Encoded: false,
    statusCode,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: text,
  };
}

function getQuery(event: ScfEvent): Record<string, string> {
  return { ...(event.queryStringParameters ?? {}), ...(event.queryString ?? {}) };
}

/**
 * SCF handler 入口
 */
export async function main(event: ScfEvent, _ctx?: ScfContext): Promise<ScfResult> {
  const env = process.env as unknown as ScfEnv;
  const method = (event.httpMethod ?? event.method ?? 'GET').toUpperCase();
  const path = event.path ?? event.rawPath ?? '/';
  const query = getQuery(event);

  if (path === '/diag') return diagnostics(env);

  // 体重 webhook：国内入口，解析后存入 COS，Worker 日报时从 COS 读取
  if (path === '/webhook/weight') {
    return handleWeightWebhook(event, env);
  }

  if (path !== '/wecom/callback') {
    return textResult(200, 'Garmin WeCom SCF 运行中。回调路径 /wecom/callback，体重数据 /webhook/weight，诊断 /diag。');
  }

  if (!env.WECOM_CORP_ID || !env.WECOM_CORP_SECRET || !env.WECOM_TOKEN || !env.WECOM_ENCODING_AES_KEY) {
    return textResult(500, 'WeCom 环境变量未配置');
  }

  if (method === 'GET') return handleGet(env, query);
  if (method === 'POST') return handlePost(event, env);
  return jsonResult(405, { error: 'Method Not Allowed' });
}

/**
 * GET：URL 校验。必须 1 秒内返回解密后的明文 echostr（无引号/BOM/换行）
 */
async function handleGet(env: WecomChatEnv, query: Record<string, string>): Promise<ScfResult> {
  const msgSignature = query.msg_signature ?? '';
  const timestamp = query.timestamp ?? '';
  const nonce = query.nonce ?? '';
  const echostr = query.echostr ?? '';
  if (!msgSignature || !timestamp || !nonce || !echostr) {
    return textResult(400, 'Missing params');
  }
  const valid = await verifySignature(env.WECOM_TOKEN!, timestamp, nonce, echostr, msgSignature);
  if (!valid) return textResult(403, 'Signature mismatch');
  try {
    const plain = await decryptMessage(env.WECOM_ENCODING_AES_KEY!, echostr, env.WECOM_CORP_ID!);
    return textResult(200, plain);
  } catch (err) {
    return textResult(500, `Decrypt failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * POST：接收消息。同步处理后返回加密被动回复 XML（完全绕开可信 IP 白名单）。
 *
 * 企业微信 5 秒超时会重试；MsgId 去重标记在处理之后写入，
 * 第一次超时后重试时能重新处理并返回回复。
 */
async function handlePost(event: ScfEvent, env: WecomChatEnv): Promise<ScfResult> {
  const query = getQuery(event);
  const msgSignature = query.msg_signature ?? '';
  const timestamp = query.timestamp ?? '';
  const nonce = query.nonce ?? '';
  if (!msgSignature || !timestamp || !nonce) return textResult(400, 'Missing params');

  let bodyText = event.body ?? '';
  if (event.isBase64Encoded) {
    bodyText = Buffer.from(bodyText, 'base64').toString('utf-8');
  }
  const encrypted = extractCData(bodyText, 'Encrypt');
  if (!encrypted) return textResult(400, 'Missing <Encrypt>');

  const valid = await verifySignature(env.WECOM_TOKEN!, timestamp, nonce, encrypted, msgSignature);
  if (!valid) return textResult(403, 'Signature mismatch');

  let xml: string;
  try {
    xml = await decryptMessage(env.WECOM_ENCODING_AES_KEY!, encrypted, env.WECOM_CORP_ID!);
  } catch (err) {
    return textResult(500, `Decrypt failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const fromUser = extractCData(xml, 'FromUserName');
  const content = extractCData(xml, 'Content');
  const msgId = extractCData(xml, 'MsgId');
  const msgType = extractCData(xml, 'MsgType');
  if (msgType && msgType !== 'text') return textResult(200, 'success');
  if (!fromUser || !content || !msgId) return textResult(400, 'Invalid XML');

  // 同实例 MsgId 去重：标记在处理之后写入，避免第一次超时后重试仍被拦
  const already = !shouldProcess(msgId);
  if (already) return textResult(200, 'success');

  const started = Date.now();
  let reply = '';
  try {
    reply = await handleUserMessage(env, fromUser, content);
    console.log(`[scf] 处理完成 userId=${fromUser} 耗时=${Date.now() - started}ms`);
  } catch (err) {
    console.error('[scf] 处理失败', err);
    reply = `处理失败：${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`;
  }

  try {
    const innerXml = buildTextReplyBodyXml(fromUser, env.WECOM_CORP_ID!, reply);
    const replyXml = await buildPassiveReplyXml(
      env.WECOM_ENCODING_AES_KEY!,
      env.WECOM_TOKEN!,
      env.WECOM_CORP_ID!,
      innerXml,
    );
    return {
      isBase64Encoded: false,
      statusCode: 200,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      body: replyXml,
    };
  } catch (err) {
    console.error('[scf] 被动回复加密失败', err);
    return textResult(200, 'success');
  }
}

/**
 * 体重 webhook：SCF 作为大陆可直连入口，解析后存入腾讯云 COS，
 * Worker 日报生成时从 COS 公有读读取展示。
 *
 * 这样体重 webhook 的解析逻辑复用 Worker 端 parseWeightPayload，
 * 存储走 COS（SCF 写 + Worker 读），不依赖 workers.dev 网络。
 */
async function handleWeightWebhook(event: ScfEvent, env: ScfEnv): Promise<ScfResult> {
  const method = (event.httpMethod ?? event.method ?? 'GET').toUpperCase();
  if (method !== 'POST') {
    return jsonResult(405, { status: 'error', message: '仅支持 POST 请求' });
  }
  if (!env.COS_SECRET_ID || !env.COS_SECRET_KEY || !env.COS_BUCKET || !env.COS_REGION) {
    return jsonResult(503, { status: 'error', message: '未配置 COS 环境变量' });
  }

  let bodyText = event.body ?? '';
  if (event.isBase64Encoded) {
    bodyText = Buffer.from(bodyText, 'base64').toString('utf-8');
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonResult(400, { status: 'error', message: '请求体不是有效 JSON' });
  }

  let measurement;
  try {
    measurement = parseWeightPayload(body, Date.now());
  } catch (err) {
    return jsonResult(400, {
      status: 'error',
      message: `数据无效：${err instanceof Error ? err.message : String(err)}`,
    });
  }

  try {
    await putWeightToCos(
      {
        secretId: env.COS_SECRET_ID!,
        secretKey: env.COS_SECRET_KEY!,
        bucket: env.COS_BUCKET!,
        region: env.COS_REGION!,
      },
      measurement.date,
      JSON.stringify(measurement),
    );
  } catch (err) {
    return jsonResult(502, {
      status: 'error',
      message: `写入 COS 失败：${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return jsonResult(200, {
    status: 'ok',
    date: measurement.date,
    weightKg: measurement.weightKg,
  });
}

/**
 * 诊断：环境变量配置情况 + 云函数出口到外部依赖的连通性
 * 不输出任何密钥值
 */
async function diagnostics(env: ScfEnv): Promise<ScfResult> {
  const probe = async (url: string, init?: RequestInit): Promise<unknown> => {
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      return { ok: true, status: resp.status, ms: Date.now() - t0 };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 };
    }
  };

  const [s3, garmin, deepseek, cos, egressIp] = await Promise.all([
    probe('https://thegarth.s3.amazonaws.com/oauth_consumer.json'),
    probe('https://connectapi.garmin.com/'),
    probe(`${env.AI_BASE_URL ?? 'https://api.deepseek.com'}/models`, {
      headers: env.AI_API_KEY ? { Authorization: `Bearer ${env.AI_API_KEY}` } : undefined,
    }),
    // COS 连通性：GET 一个不存在的对象，预期 404（NoSuchKey）即说明网络通 + bucket 存在
    env.COS_BUCKET && env.COS_REGION
      ? probe(
          `https://${env.COS_BUCKET}.cos.${env.COS_REGION}.myqcloud.com/weight/_diag_probe.json`,
        )
      : Promise.resolve({ ok: false, error: '未配置 COS_BUCKET / COS_REGION' }),
    getEgressIp(),
  ]);

  return jsonResult(200, {
    time: new Date().toISOString(),
    egressIp,
    egressIpHint: egressIp ? '把此 IP 加入企业微信应用的「企业可信IP」白名单' : '出口 IP 探测失败',
    config: {
      WECOM_CORP_ID: !!env.WECOM_CORP_ID,
      WECOM_CORP_SECRET: !!env.WECOM_CORP_SECRET,
      WECOM_AGENT_ID: !!env.WECOM_AGENT_ID,
      WECOM_TOKEN: !!env.WECOM_TOKEN,
      WECOM_ENCODING_AES_KEY: !!env.WECOM_ENCODING_AES_KEY,
      AI_API_KEY: !!env.AI_API_KEY,
      GARMIN_OAUTH1_TOKEN: !!env.GARMIN_OAUTH1_TOKEN,
      GARMIN_OAUTH1_TOKEN_SECRET: !!env.GARMIN_OAUTH1_TOKEN_SECRET,
      COS_SECRET_ID: !!env.COS_SECRET_ID,
      COS_SECRET_KEY: !!env.COS_SECRET_KEY,
      COS_BUCKET: !!env.COS_BUCKET,
      COS_REGION: !!env.COS_REGION,
    },
    connectivity: {
      garmin_oauth_consumer_s3: s3,
      garmin_connectapi: garmin,
      ai_provider_models: deepseek,
      // status 404 是正常的（探测对象不存在）；403/网络错误才是异常
      cos_weight_bucket: cos,
    },
  });
}

/**
 * 探测云函数公网出口 IP（即企业微信看到的调用方 IP）
 * 依次尝试国内/国外回显服务，取第一个返回的 IPv4
 */
async function getEgressIp(): Promise<string | null> {
  const candidates = [
    'https://myip.ipip.net/',
    'https://members.3322.org/dyndns/getip',
    'https://api.ipify.org?format=json',
  ];
  for (const url of candidates) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      const text = await resp.text();
      const match = text.match(/\d{1,3}(?:\.\d{1,3}){3}/);
      if (match) return match[0];
    } catch {
      // 尝试下一个
    }
  }
  return null;
}
