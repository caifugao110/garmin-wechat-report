/**
 * 企业微信消息加解密（WXBizMsgCrypt）Workers 实现
 *
 * 官方文档：https://developer.work.weixin.qq.com/document/path/90930
 *
 * 仅实现解密 + 验签，回复走主动消息接口（不加密回包），故无需 encrypt()。
 * 全程 Web Crypto API，无外部依赖，Node 与 Workers 通用。
 *
 * 编码格式：
 * - EncodingAESKey 是 43 字符 base64，拼 "=" 后解码为 32 字节 AES key
 * - IV = key 前 16 字节
 * - 密文 base64 解码 → AES-256-CBC + PKCS7 解密
 * - 明文结构：16B random + 4B msg_len(大端) + msg + corpId
 */

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * 校验消息签名
 *
 * 算法：把 token / timestamp / nonce / encrypted 按字典序升序拼接后 SHA1，
 * 十六进制串与传入的 msgSignature 比较。
 *
 * GET URL 校验时 encrypted = echostr；
 * POST 接收消息时 encrypted = XML 中 <Encrypt> 字段值。
 */
export async function verifySignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string,
  msgSignature: string,
): Promise<boolean> {
  const arr = [token, timestamp, nonce, encrypted].sort();
  const data = TEXT_ENCODER.encode(arr.join(''));
  const digest = await crypto.subtle.digest('SHA-1', data);
  const computed = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return computed === msgSignature;
}

/**
 * 解密企业微信回调中的密文
 *
 * @param encodingAESKey 43 字符 base64
 * @param encrypted base64 密文（来自 echostr 或 <Encrypt>）
 * @param expectedCorpId 期望尾部的 corpId，不匹配则抛错（防篡改）
 * @returns 解密后的明文消息
 */
export async function decryptMessage(
  encodingAESKey: string,
  encrypted: string,
  expectedCorpId: string,
): Promise<string> {
  const key = decodeAESKey(encodingAESKey);
  const iv = key.slice(0, 16);
  const ciphertext = base64ToBytes(encrypted);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as unknown as BufferSource,
    { name: 'AES-CBC' },
    false,
    ['encrypt', 'decrypt'],
  );
  const bytes = await rawDecryptCbc(cryptoKey, iv, ciphertext);

  // 16B random + 4B msg_len(大端) + msg + corpId
  const msgLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16);
  if (16 + 4 + msgLen + expectedCorpId.length > bytes.length) {
    throw new Error('解密后数据长度不匹配');
  }
  const msg = TEXT_DECODER.decode(bytes.slice(20, 20 + msgLen));
  const corpId = TEXT_DECODER.decode(bytes.slice(20 + msgLen)).replace(/\0+$/, '').trimEnd();
  if (corpId !== expectedCorpId) {
    throw new Error(`corpId 不匹配：期望 ${expectedCorpId}，实际 ${corpId}`);
  }
  return msg;
}

/**
 * AES-CBC 解密并保留完整明文（不去任何填充）
 *
 * Web Crypto 的 AES-CBC 强制按 16 字节 PKCS7 去除末尾填充，而企业微信用的是
 * 32 字节块大小的自定义填充（pad 可能为 17-32，标准解密会报错或截断错误）。
 *
 * 解法：在原密文末尾追加一个自制密文块 C'。
 *   CBC 解密：P' = D(C') XOR C_last，让 P' 恰好为 16 个 0x10（合法 16 字节填充），
 *   则 Web Crypto 只剥掉这个自制块，原始明文（含微信填充）被完整保留，
 *   之后由调用方按 32 字节规则自行去填充。
 */
async function rawDecryptCbc(
  cryptoKey: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error('密文长度非法');
  }
  const lastBlock = ciphertext.slice(ciphertext.length - 16);
  // 用 C_last 作为 IV 加密 16 字节 0x10，得到的密文块接到末尾。
  // 注意：subtle.encrypt 对 16 字节对齐输入仍会自动追加一块 16 字节填充，
  // 输出是 32 字节，raw CBC 密文块只取前 16 字节。
  const padPlain = new Uint8Array(16).fill(0x10);
  const appendedFull = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: lastBlock as unknown as BufferSource },
      cryptoKey,
      padPlain as unknown as BufferSource,
    ),
  );
  const appended = appendedFull.slice(0, 16);
  const combined = new Uint8Array(ciphertext.length + appended.length);
  combined.set(ciphertext, 0);
  combined.set(appended, ciphertext.length);

  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: iv as unknown as BufferSource },
      cryptoKey,
      combined as unknown as BufferSource,
    ),
  );

  // 手动去除企业微信 32 字节块填充
  const pad = plain[plain.length - 1];
  if (pad < 1 || pad > 32 || pad > plain.length) {
    throw new Error('填充值非法');
  }
  for (let i = plain.length - pad; i < plain.length; i++) {
    if (plain[i] !== pad) throw new Error('填充字节不一致');
  }
  return plain.slice(0, plain.length - pad);
}

/**
 * 43 字符 EncodingAESKey → 32 字节 AES key
 */
function decodeAESKey(encodingAESKey: string): Uint8Array {
  const base64 = encodingAESKey + '=';
  return base64ToBytes(base64);
}

/**
 * base64 → Uint8Array（Workers 与 Node 都支持 atob）
 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const buffer = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Uint8Array → base64
 */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * 计算消息签名（SHA-1，按企业微信算法）
 *
 * 与 verifySignature 共用同一算法；此处返回签名字符串本身，
 * 用于生成被动回复 XML 的 MsgSignature 字段。
 */
export async function computeSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string,
): Promise<string> {
  const arr = [token, timestamp, nonce, encrypted].sort();
  const digest = await crypto.subtle.digest('SHA-1', TEXT_ENCODER.encode(arr.join('')));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 加密消息体（用于被动回复 / echostr 加密场景）
 *
 * 流程：构造明文（16B random + 4B msg_len + msg + corpId）
 * → 32 字节块 PKCS7 填充 → AES-256-CBC 加密
 * → 切掉 WebCrypto 自动追加的 16 字节 PKCS7 块
 * → base64 编码
 */
export async function encryptMessage(
  encodingAESKey: string,
  msg: string,
  corpId: string,
): Promise<string> {
  const key = decodeAESKey(encodingAESKey);
  const iv = key.slice(0, 16);
  const msgBytes = TEXT_ENCODER.encode(msg);
  const random16 = crypto.getRandomValues(new Uint8Array(16));
  const lenBuf = new ArrayBuffer(4);
  new DataView(lenBuf).setUint32(0, msgBytes.length);

  const body = new Uint8Array(16 + 4 + msgBytes.length + corpId.length);
  body.set(random16, 0);
  body.set(new Uint8Array(lenBuf), 16);
  body.set(msgBytes, 20);
  body.set(TEXT_ENCODER.encode(corpId), 20 + msgBytes.length);

  // 企业微信 32 字节块填充
  const pad = 32 - (body.length % 32);
  const padded = new Uint8Array(body.length + pad);
  padded.set(body);
  padded.fill(pad, body.length);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as unknown as BufferSource,
    { name: 'AES-CBC' },
    false,
    ['encrypt', 'decrypt'],
  );

  const encryptedFull = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: iv as unknown as BufferSource },
      cryptoKey,
      padded as unknown as BufferSource,
    ),
  );
  // WebCrypto 会自动追加一块 16 字节 PKCS7（即使输入已对齐），切掉
  const rawCt = encryptedFull.slice(0, padded.length);
  return bytesToBase64(rawCt);
}

/**
 * 构造被动回复 XML 包（加密消息 + MsgSignature + TimeStamp + Nonce）
 *
 * 企业微信被动回复的完整流程：
 * 1. 构造回复消息体（inner XML：ToUserName/FromUserName/CreateTime/MsgType/Content）
 * 2. encryptMessage(innerXml, corpId) → base64 加密串
 * 3. 构造外层 XML：<Encrypt> + <MsgSignature> + <TimeStamp> + <Nonce>
 * 4. 外层 XML 直接作为 POST 响应体返回
 *
 * 注意：ToUserName 应为消息发送方的 UserID（即原 XML 中的 FromUserName），
 *       FromUserName 应为我们的 CorpID。消息体由调用方保证正确，
 *       本函数只负责加密 + 签名 + 拼外层 XML。
 *
 * @param innerXml 完整的回复消息体 XML（含根 <xml> 标签）
 * @returns 可直接作为 POST 响应体返回的完整加密 XML 字符串
 */
export async function buildPassiveReplyXml(
  encodingAESKey: string,
  token: string,
  corpId: string,
  innerXml: string,
): Promise<string> {
  const encrypted = await encryptMessage(encodingAESKey, innerXml, corpId);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomNonce();
  const msgSignature = await computeSignature(token, timestamp, nonce, encrypted);

  return [
    '<xml>',
    `<Encrypt><![CDATA[${encrypted}]]></Encrypt>`,
    `<MsgSignature><![CDATA[${msgSignature}]]></MsgSignature>`,
    `<TimeStamp>${timestamp}</TimeStamp>`,
    `<Nonce><![CDATA[${nonce}]]></Nonce>`,
    '</xml>',
  ].join('');
}

const NONCE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function randomNonce(len = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += NONCE_CHARS[b % NONCE_CHARS.length];
  return s;
}

/**
 * 构造被动回复的消息体 XML（inner XML，传给 buildPassiveReplyXml 加密）
 */
export function buildTextReplyBodyXml(
  toUserId: string,
  fromCorpId: string,
  content: string,
  createTime?: number,
): string {
  const ts = createTime ?? Math.floor(Date.now() / 1000);
  // 简单转义：Content 中的特殊字符用 CDATA 包裹已足够，无需再 esc
  return [
    '<xml>',
    `<ToUserName><![CDATA[${toUserId}]]></ToUserName>`,
    `<FromUserName><![CDATA[${fromCorpId}]]></FromUserName>`,
    `<CreateTime>${ts}</CreateTime>`,
    `<MsgType><![CDATA[text]]></MsgType>`,
    `<Content><![CDATA[${content}]]></Content>`,
    '</xml>',
  ].join('');
}
