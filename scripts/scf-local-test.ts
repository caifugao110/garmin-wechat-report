/**
 * SCF handler 本地模拟测试
 *
 * 用法：npm run build:scf && npm run test:scf
 *
 * 覆盖：
 * 1. GET  URL 验证（真实 Token/AESKey/CorpID 加解密往返）
 * 2. 对话主循环（闲聊 + Garmin 工具调用，真实 DeepSeek/Garmin 请求）
 * 3. POST 事件结构（假 userid，sendText 失败被 catch 属预期，只验证流程与解密）
 * 4. /diag 诊断事件
 *
 * 注意：需先 npm run build:scf 生成 scf-dist/index.js
 */
import 'dotenv/config';
import { createRequire } from 'node:module';
import type { ScfEvent, ScfResult } from '../src/scf/handler.js';
import { handleUserMessage } from '../src/wecom/chat.js';
import type { WecomChatEnv } from '../src/wecom/types.js';

const require = createRequire(import.meta.url);
// CJS 打包产物，含 exports.main
const scf = require('../scf-dist/index.js') as { main: (e: ScfEvent) => Promise<ScfResult> };

const TOKEN = process.env.WECOM_TOKEN!;
const AES_KEY = process.env.WECOM_ENCODING_AES_KEY!;
const CORP_ID = process.env.WECOM_CORP_ID!;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function sha1Sorted(parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(parts.sort().join('')));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 按企业微信 32 字节块填充规则加密，输出 base64 密文（raw CBC，不含 WebCrypto 自动填充块） */
async function wecomEncrypt(plain: string): Promise<string> {
  const keyBytes = b64ToBytes(AES_KEY + '=');
  const iv = keyBytes.slice(0, 16);
  const msgBytes = new TextEncoder().encode(plain);
  const corpBytes = new TextEncoder().encode(CORP_ID);
  const random16 = crypto.getRandomValues(new Uint8Array(16));
  const lenBuf = new ArrayBuffer(4);
  new DataView(lenBuf).setUint32(0, msgBytes.length);
  const body = new Uint8Array(16 + 4 + msgBytes.length + corpBytes.length);
  body.set(random16, 0);
  body.set(new Uint8Array(lenBuf), 16);
  body.set(msgBytes, 20);
  body.set(corpBytes, 20 + msgBytes.length);
  const pad = 32 - (body.length % 32);
  const padded = new Uint8Array(body.length + pad);
  padded.set(body);
  padded.fill(pad, body.length);
  const ck = await crypto.subtle.importKey('raw', keyBytes as unknown as BufferSource, { name: 'AES-CBC' }, false, ['encrypt']);
  const full = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: iv as unknown as BufferSource }, ck, padded as unknown as BufferSource));
  const rawCt = full.slice(0, padded.length);
  let bin = '';
  for (const b of rawCt) bin += String.fromCharCode(b);
  return btoa(bin);
}

function assert(cond: boolean, label: string, extra?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    if (extra !== undefined) console.log('      ', extra);
    process.exitCode = 1;
  }
}

async function testGet() {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'localtest';
  const plain = 'scf-verify-ok';
  const echostr = await wecomEncrypt(plain);
  const msg_signature = await sha1Sorted([TOKEN, timestamp, nonce, echostr]);

  const event: ScfEvent = {
    httpMethod: 'GET',
    path: '/wecom/callback',
    queryString: { msg_signature, timestamp, nonce, echostr },
  };
  const res = await scf.main(event);
  assert(res.statusCode === 200, `GET 验证 statusCode=200（实际 ${res.statusCode}）`, res);
  assert(res.body === plain, `GET 返回明文 echostr 且无多余字符（实际 ${JSON.stringify(res.body)}）`);
}

async function testChat() {
  const env = process.env as unknown as WecomChatEnv;
  console.log('\n--- 对话：闲聊 ---');
  const r1 = await handleUserMessage(env, 'local-test', '你好，用一句话介绍你自己');
  console.log('AI:', r1.slice(0, 120));
  assert(r1.length > 0, '闲聊有回复');

  console.log('\n--- 对话：Garmin 工具调用（昨日步数）---');
  const r2 = await handleUserMessage(env, 'local-test', '我昨天走了多少步？');
  console.log('AI:', r2.slice(0, 200));
  assert(/\d/.test(r2) && !/ERROR/i.test(r2), '步数回复含数字且无 ERROR', r2);
}

async function testPostStructure() {
  // 构造加密的微信文本消息 XML
  const innerXml = `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><FromUserName><![CDATA[local_test_user]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好]]></Content><MsgId>1234567890123</MsgId><AgentID><![CDATA[${process.env.WECOM_AGENT_ID}]]></AgentID></xml>`;
  const encrypt = await wecomEncrypt(innerXml);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'localtest';
  const msg_signature = await sha1Sorted([TOKEN, timestamp, nonce, encrypt]);
  const bodyXml = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;

  const event: ScfEvent = {
    httpMethod: 'POST',
    path: '/wecom/callback',
    queryString: { msg_signature, timestamp, nonce },
    headers: { 'content-type': 'text/xml' },
    body: Buffer.from(bodyXml, 'utf-8').toString('base64'),
    isBase64Encoded: true,
  };
  const res = await scf.main(event);
  // 被动回复：返回加密 XML（含 <Encrypt> + <MsgSignature>），Content-Type 应为 application/xml
  assert(res.statusCode === 200, 'POST statusCode=200');
  assert(res.headers['Content-Type']?.includes('xml'), 'Content-Type 含 xml', res.headers);
  assert(/<Encrypt><!\[CDATA\[/.test(res.body), 'body 含 <Encrypt>');
  assert(/<MsgSignature><!\[CDATA\[/.test(res.body), 'body 含 <MsgSignature>');

  // 重复 MsgId 应被去重（已处理过，静默返回 success）
  const res2 = await scf.main(event);
  assert(res2.body === 'success', '重复 MsgId 幂等返回 success');
}

async function testDiag() {
  const res = await scf.main({ httpMethod: 'GET', path: '/diag' });
  assert(res.statusCode === 200, '/diag 200');
  const data = JSON.parse(res.body) as { config?: Record<string, boolean>; connectivity?: Record<string, unknown> };
  console.log('config:', data.config);
  console.log('connectivity:', data.connectivity);
}

(async () => {
  console.log('=== 1. GET URL 验证（模拟企业微信）===');
  await testGet();
  console.log('\n=== 2. 对话主循环 ===');
  await testChat();
  console.log('\n=== 3. POST 事件结构（假 userid，sendText 失败属预期）===');
  await testPostStructure();
  console.log('\n=== 4. /diag 诊断 ===');
  await testDiag();
  console.log(process.exitCode ? '\n存在失败项' : '\n全部通过');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
