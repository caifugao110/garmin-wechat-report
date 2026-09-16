/**
 * 企业微信自建应用消息回调路由
 *
 * 官方文档：https://developer.work.weixin.qq.com/document/path/90930
 *
 * - GET：URL 校验（验签 + 解密 echostr 返回明文）
 * - POST：接收用户消息（验签 + 解密 XML → 同步处理 → 返回加密被动回复 XML）
 *
 * 被动回复（而非主动 send API）的原因：
 *   send API 需要调用方出口 IP 在企业微信「企业可信IP」白名单中。
 *   Cloudflare Workers 出口 IP 池过大、免费版不可预测，无法加白名单。
 *   腾讯云函数同理（除非绑定固定 NAT/EIP）。
 *   被动回复完全在 POST 响应里返回加密 XML，零出站调用，绕过白名单。
 *
 * ⚠️ Cloudflare Worker 约束：免费版 CPU 时间限制 50ms，
 *    LLM + Garmin 热路径 2-5s 可能超限，导致 Worker 返回 500。
 *    付费版 30s CPU 限制足够。国内用户请改用腾讯云函数 SCF。
 *
 * 防重试：module-level Set<MsgId> 去重，TTL 60s，标记在处理之后写入。
 */

import type { WecomChatEnv } from './types.js';
import { verifySignature, decryptMessage, buildPassiveReplyXml, buildTextReplyBodyXml } from './crypto.js';
import { handleUserMessage } from './chat.js';

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const MSG_ID_TTL_MS = 60_000;
const seenMsgIds = new Map<string, number>();

/**
 * 入口：根据 method 分流 GET / POST
 */
export async function handleCallback(
  request: Request,
  env: WecomChatEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!env.WECOM_CORP_ID || !env.WECOM_TOKEN || !env.WECOM_ENCODING_AES_KEY) {
    return new Response('WeCom 对话配置缺失', { status: 500 });
  }

  void ctx; // Worker 仍暴露 ctx.waitUntil 供未来扩展，但 POST 同步处理已足够
  const method = request.method.toUpperCase();
  if (method === 'GET') return handleGet(request, env);
  if (method === 'POST') return handlePost(request, env);
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
}

/**
 * GET：URL 校验
 * WeCom 后台「接收消息 API」点保存时回调
 */
async function handleGet(request: Request, env: WecomChatEnv): Promise<Response> {
  const url = new URL(request.url);
  const msgSignature = url.searchParams.get('msg_signature') ?? '';
  const timestamp = url.searchParams.get('timestamp') ?? '';
  const nonce = url.searchParams.get('nonce') ?? '';
  const echostr = url.searchParams.get('echostr') ?? '';

  if (!msgSignature || !timestamp || !nonce || !echostr) {
    return new Response('Missing params', { status: 400 });
  }

  const valid = await verifySignature(env.WECOM_TOKEN!, timestamp, nonce, echostr, msgSignature);
  if (!valid) return new Response('Signature mismatch', { status: 403 });

  try {
    const decrypted = await decryptMessage(env.WECOM_ENCODING_AES_KEY!, echostr, env.WECOM_CORP_ID!);
    return new Response(decrypted, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Decrypt failed: ${msg}`, { status: 500 });
  }
}

/**
 * POST：接收用户消息
 * 同步处理对话后返回加密被动回复 XML（绕开可信 IP 白名单）
 */
async function handlePost(request: Request, env: WecomChatEnv): Promise<Response> {
  const url = new URL(request.url);
  const msgSignature = url.searchParams.get('msg_signature') ?? '';
  const timestamp = url.searchParams.get('timestamp') ?? '';
  const nonce = url.searchParams.get('nonce') ?? '';

  if (!msgSignature || !timestamp || !nonce) {
    return new Response('Missing params', { status: 400 });
  }

  const bodyText = await request.text();
  const encrypted = extractCData(bodyText, 'Encrypt');
  if (!encrypted) {
    return new Response('Missing <Encrypt>', { status: 400 });
  }

  const valid = await verifySignature(env.WECOM_TOKEN!, timestamp, nonce, encrypted, msgSignature);
  if (!valid) return new Response('Signature mismatch', { status: 403 });

  let decryptedXml: string;
  try {
    decryptedXml = await decryptMessage(env.WECOM_ENCODING_AES_KEY!, encrypted, env.WECOM_CORP_ID!);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Decrypt failed: ${msg}`, { status: 500 });
  }

  const fromUser = extractCData(decryptedXml, 'FromUserName');
  const content = extractCData(decryptedXml, 'Content');
  const msgId = extractCData(decryptedXml, 'MsgId');
  const msgType = extractCData(decryptedXml, 'MsgType');

  // 非文本消息：图片/语音/事件等，暂不支持，静默 ack
  if (msgType && msgType !== 'text') {
    return successResponse();
  }
  if (!fromUser || !content || !msgId) {
    return new Response('Invalid XML', { status: 400 });
  }

  // 同实例 MsgId 去重：标记在处理之后写入，避免第一次超时后重试仍被拦
  const already = !shouldProcess(msgId);
  if (already) return successResponse();

  let reply = '';
  try {
    reply = await handleUserMessage(env, fromUser, content);
  } catch (err) {
    console.error('[wecom] handleUserMessage failed', err);
    reply = `处理失败：${(err instanceof Error ? err.message : String(err)).slice(0, 500)}`;
  }

  try {
    const innerXml = buildTextReplyBodyXml(fromUser, env.WECOM_CORP_ID!, reply);
    const replyXml = await buildPassiveReplyXml(
      env.WECOM_ENCODING_AES_KEY!,
      env.WECOM_TOKEN!,
      env.WECOM_CORP_ID!,
      innerXml,
    );
    return new Response(replyXml, {
      status: 200,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
  } catch (err) {
    console.error('[wecom] 被动回复加密失败', err);
    return successResponse();
  }
}

function successResponse(): Response {
  return new Response('success', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * 检查 MsgId 是否首次出现；首次返回 true 并记录
 * 顺手清理过期项
 */
export function shouldProcess(msgId: string): boolean {
  const now = Date.now();
  for (const [id, ts] of seenMsgIds) {
    if (now - ts > MSG_ID_TTL_MS) seenMsgIds.delete(id);
  }
  if (seenMsgIds.has(msgId)) return false;
  seenMsgIds.set(msgId, now);
  return true;
}

/**
 * 从 XML 提取 CDATA 或纯文本字段值
 *
 * 优先匹配 <Tag><![CDATA[value]]></Tag>，回退到 <Tag>value</Tag>
 */
export function extractCData(xml: string, tag: string): string | null {
  const cdataRe = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i');
  const m1 = xml.match(cdataRe);
  if (m1) return m1[1];
  const plainRe = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i');
  const m2 = xml.match(plainRe);
  return m2 ? m2[1] : null;
}
