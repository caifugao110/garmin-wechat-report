/**
 * 企业微信群机器人推送
 * 官方文档：https://developer.work.weixin.qq.com/document/path/91770
 *
 * 推送规则：
 * 1. Webhook 形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=KEY
 *    配置时只需填 key 部分（WECOM_BOT_KEY），由本模块拼完整 URL
 * 2. 消息类型用 markdown，单条 content 上限 4096 字节（UTF-8）
 *    超过上限时按行边界切片，分多条发送
 * 3. 成功响应 JSON errcode === 0
 */

/** 单条 markdown content 字节上限（留余量给 JSON 外层与转义开销） */
const MAX_CONTENT_BYTES = 3500;

export interface PushResult {
  success: boolean;
  message: string;
}

interface WecomResponse {
  errcode?: number;
  errmsg?: string;
}

/**
 * 构造完整 webhook URL
 */
function buildWebhookUrl(key: string): string {
  return `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`;
}

/**
 * 估算字符串 UTF-8 字节长度
 * Web 环境无 Buffer，用 TextEncoder 统一处理
 */
function byteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

/**
 * 把长文本按字节上限切成多段（保证不切断一行）
 * 单行本身超限时再硬切，避免死循环
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
      // 当前行加进去会超：先把已有内容存起来
      pushCur();
      if (byteLength(line) > maxBytes) {
        // 单行就超，硬切
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

/**
 * 单条 markdown 消息发送
 */
async function sendMarkdown(url: string, content: string): Promise<WecomResponse> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'markdown',
      markdown: { content },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { errcode: resp.status, errmsg: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
  }
  return (await resp.json()) as WecomResponse;
}

/**
 * 推送 Markdown 报告到企业微信群
 *
 * @param key 企业微信群机器人 Webhook key（URL 中 key= 后面的部分）
 */
export async function pushReport(
  key: string | undefined,
  title: string,
  desp: string,
): Promise<PushResult> {
  if (!key) {
    return { success: false, message: 'WECOM_BOT_KEY 未配置' };
  }

  const url = buildWebhookUrl(key);
  // 标题作为首段，正文按字节切片后追加
  const full = `## ${title}\n\n${desp}`;
  const chunks = splitByBytes(full, MAX_CONTENT_BYTES);

  try {
    for (let i = 0; i < chunks.length; i++) {
      const content =
        chunks.length > 1
          ? `${chunks[i]}\n\n_(${i + 1}/${chunks.length})_`
          : chunks[i];
      const data = await sendMarkdown(url, content);
      if (data.errcode !== 0) {
        return {
          success: false,
          message: `企业微信返回错误：errcode=${data.errcode}, errmsg=${data.errmsg ?? 'unknown'}`,
        };
      }
    }
    return { success: true, message: '推送成功' };
  } catch (err) {
    return {
      success: false,
      message: `推送请求失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
