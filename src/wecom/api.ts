/**
 * 企业微信自建应用 OpenAPI 客户端
 *
 * 文档：
 * - 获取 access_token：https://developer.work.weixin.qq.com/document/path/91039
 * - 发送应用消息：    https://developer.work.weixin.qq.com/document/path/90236
 *
 * access_token 在 isolate 级缓存（TTL 7100s，官方 7200s 留余量）；
 * 冷启动或过期时按需重取，单用户场景足够。多用户/持久化升级到 KV。
 */

import type { WecomAppEnv } from './types.js';

const GET_TOKEN_URL = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken';
const SEND_MSG_URL = 'https://qyapi.weixin.qq.com/cgi-bin/message/send';

/** 文本消息单条 content 上限（UTF-8 字节，留余量） */
const MAX_TEXT_BYTES = 2000;

interface GetTokenResponse {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
}

interface SendMsgResponse {
  errcode?: number;
  errmsg?: string;
  msgid?: string;
}

interface CachedToken {
  token: string;
  /** Unix ms，过期时间 */
  expiresAt: number;
}

let cache: CachedToken | null = null;

/**
 * 取 access_token；缓存有效则复用，否则远程刷新
 */
export async function getAccessToken(env: WecomAppEnv): Promise<string> {
  if (cache && cache.expiresAt > Date.now() + 60_000) {
    return cache.token;
  }
  if (!env.WECOM_CORP_ID || !env.WECOM_CORP_SECRET) {
    throw new Error('WeCom 配置缺失：WECOM_CORP_ID/WECOM_CORP_SECRET');
  }
  const url = `${GET_TOKEN_URL}?corpid=${encodeURIComponent(env.WECOM_CORP_ID)}&corpsecret=${encodeURIComponent(env.WECOM_CORP_SECRET)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`gettoken HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as GetTokenResponse;
  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`gettoken 失败：errcode=${data.errcode}, errmsg=${data.errmsg}`);
  }
  const expiresIn = data.expires_in ?? 7200;
  cache = {
    token: data.access_token,
    expiresAt: Date.now() + expiresIn * 1000 - 60_000,
  };
  return cache.token;
}

/**
 * 强制失效缓存（access_token 报错 42001/40014 时调用）
 */
export function invalidateToken(): void {
  cache = null;
}

/**
 * 发送文本消息给指定用户
 *
 * @param touser 用户的 userid（来自回调 XML 的 <FromUserName>）
 * @param content 文本内容，超 2000 字节按行切片分多条发送
 */
export async function sendText(env: WecomAppEnv, touser: string, content: string): Promise<void> {
  const agentId = Number(env.WECOM_AGENT_ID);
  if (!Number.isFinite(agentId)) {
    throw new Error(`WECOM_AGENT_ID 非法：${env.WECOM_AGENT_ID}`);
  }

  const chunks = splitByBytes(content, MAX_TEXT_BYTES);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks.length > 1 ? `${chunks[i]} (${i + 1}/${chunks.length})` : chunks[i];
    await sendOneChunk(env, touser, agentId, chunk);
  }
}

async function sendOneChunk(env: WecomAppEnv, touser: string, agentId: number, content: string): Promise<void> {
  const accessToken = await getAccessToken(env);
  const url = `${SEND_MSG_URL}?access_token=${encodeURIComponent(accessToken)}`;
  const body = {
    touser,
    msgtype: 'text',
    agentid: agentId,
    text: { content },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`send HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as SendMsgResponse;
  // access_token 过期相关错误，清缓存抛错，下次重试会重取
  if (data.errcode === 42001 || data.errcode === 40014) {
    invalidateToken();
    throw new Error(`access_token 失效（errcode=${data.errcode}），已清缓存请重试`);
  }
  if (data.errcode !== 0) {
    throw new Error(`发送失败：errcode=${data.errcode}, errmsg=${data.errmsg}`);
  }
}

function byteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

/**
 * 按字节切片，单行超长时硬切，避免死循环
 */
function splitByBytes(content: string, maxBytes: number): string[] {
  const lines = content.split('\n');
  const chunks: string[] = [];
  let cur = '';
  const pushCur = () => {
    if (cur) chunks.push(cur);
    cur = '';
  };
  for (const line of lines) {
    const candidate = cur ? `${cur}\n${line}` : line;
    if (byteLength(candidate) > maxBytes) {
      pushCur();
      if (byteLength(line) > maxBytes) {
        let buf = '';
        for (const ch of line) {
          if (byteLength(buf + ch) > maxBytes) {
            pushCur();
            buf = '';
          }
          buf += ch;
        }
        cur = buf;
      } else {
        cur = line;
      }
    } else {
      cur = candidate;
    }
  }
  pushCur();
  return chunks;
}
