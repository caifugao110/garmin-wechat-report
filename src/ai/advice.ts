/**
 * AI 健康建议分析（可选）
 *
 * 调用任意 OpenAI 兼容接口（DeepSeek、通义千问、Moonshot、OpenAI 等均兼容），
 * 在生成 Markdown 报告之后、推送之前，追加一段个性化自然语言建议。
 *
 * 全程用原生 fetch，无需引入 SDK，Node 与 Workers 都能跑。
 *
 * 配置项（环境变量）：
 * - AI_API_KEY   服务商 API Key（必填，未配置则跳过 AI 分析）
 * - AI_BASE_URL  接口域名，默认 https://api.deepseek.com
 * - AI_MODEL      模型名，默认 deepseek-chat
 */

export interface AiConfig {
  apiKey: string;
  /** 例如 https://api.deepseek.com */
  baseUrl: string;
  /** 例如 deepseek-chat */
  model: string;
}

/**
 * 调用 OpenAI 兼容的 /chat/completions 接口生成健康建议
 *
 * @param report 当天 Garmin 日报的完整 Markdown
 * @returns AI 返回的建议文本；失败或无内容时返回 null
 */
export async function generateAdvice(report: string, config: AiConfig): Promise<string | null> {
  const resp = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.5,
      messages: [
        {
          role: 'system',
          content: [
            '你是一名严谨的运动健康助理，基于 Garmin 健康数据给出建议。',
            '要求：只针对数据中明显偏离个人基线的指标；输出 3-5 条中文短句；',
            '不做医疗诊断，数据不足时说明。',
          ].join(''),
        },
        { role: 'user', content: `以下是我今天的 Garmin 日报：\n\n${report}` },
      ],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`AI 接口返回 ${resp.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }

  const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() ?? null;
}
