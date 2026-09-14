/**
 * Server酱（方糖）微信公众号推送
 * API 文档：https://sct.ftqq.com/docs/
 *
 * 推送规则：
 * 1. SendKey 以 sctp 开头 -> 用新版域名 https://{uid}.push.ft07.com/send/{key}.send
 *    uid 是 sctp 与 t 之间的数字（例如 sctp1234tXXX -> uid 是 1234）
 * 2. 否则 -> https://sctapi.ftqq.com/{key}.send
 * 3. 参数：title（不能含换行）、desp（Markdown 正文）
 * 4. 成功响应：JSON code === 0
 */

/**
 * 从 SendKey 提取 uid（仅对 sctp 开头的 key 有效）
 */
function extractUid(sendKey: string): string | null {
  if (!sendKey.startsWith('sctp')) return null;
  const match = sendKey.match(/^sctp(\d+)t/);
  return match ? match[1] : null;
}

/**
 * 构建推送 URL
 */
function buildPushUrl(sendKey: string): string {
  if (sendKey.startsWith('sctp')) {
    const uid = extractUid(sendKey);
    if (!uid) {
      throw new Error(`Invalid sctp sendkey format: ${sendKey}`);
    }
    return `https://${uid}.push.ft07.com/send/${sendKey}.send`;
  }
  return `https://sctapi.ftqq.com/${sendKey}.send`;
}

export interface PushResult {
  success: boolean;
  message: string;
}

/**
 * 推送 Markdown 报告到微信
 *
 * @param sendKey Server酱 SendKey（由调用方注入，Node 读环境变量 / Workers 读 secret）
 */
export async function pushReport(
  sendKey: string | undefined,
  title: string,
  desp: string,
): Promise<PushResult> {
  if (!sendKey) {
    return {
      success: false,
      message: 'SERVERCHAN_SENDKEY 未配置',
    };
  }

  const url = buildPushUrl(sendKey);
  const body = new URLSearchParams({ title, desp }).toString();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        message: `HTTP ${response.status}: ${text.slice(0, 200)}`,
      };
    }

    const data = await response.json() as { code?: number; message?: string; data?: unknown };
    if (data.code === 0) {
      return { success: true, message: '推送成功' };
    }
    return {
      success: false,
      message: `Server酱返回错误：code=${data.code}, message=${data.message ?? 'unknown'}`,
    };
  } catch (err) {
    return {
      success: false,
      message: `推送请求失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
