/**
 * 对话式 AI 助手主循环
 *
 * 复用 src/ai/advice.ts 的 OpenAI 兼容调用模式；
 * 通过 prompt-based tool call 调度 Garmin 工具（不依赖原生 function calling）。
 *
 * 流程：
 *   1. 拉会话上下文（module-level Map，TTL 30min）
 *   2. 调 LLM
 *   3. 若 LLM 返回工具调用 JSON → 执行 Garmin 工具 → 把结果作为 system 消息回灌 → 回到 2
 *   4. 若 LLM 返回纯文本 → 追加到会话 → 返回给用户
 *   5. 最多 3 轮工具调用，超过则强制收尾
 */

import type { WecomChatEnv } from './types.js';
import type { AiConfig } from '../ai/advice.js';
import { callGarminTool, type GarminEndpoint } from './garmin-tools.js';

const SYSTEM_PROMPT = [
  '你是一名 Garmin 健康助手，可以与用户对话并查询 Garmin Connect 数据。',
  '',
  '当用户询问 Garmin 数据（步数、睡眠、心率、HRV、训练状态等）时，请输出严格 JSON 工具调用，独占一行：',
  '{"tool":"garmin","endpoint":"sleep|summary|hrv|readiness|status","date":"today|yesterday|YYYY-MM-DD"}',
  '',
  '可用工具：',
  '- sleep：昨晚睡眠报告（总时长、深/浅/REM/清醒时长、评分、入睡/醒来时间、夜间血氧/呼吸/心率/压力/身体电量）',
  '- summary：每日健康总览（步数、距离、卡路里、强度分钟、心率范围、压力、身体电量充放电、血氧）',
  '- hrv：夜间 HRV（昨晚平均、7 天平均、5 分钟最高、状态、基线区间）',
  '- readiness：训练准备度（评分 0-100、等级、反馈、建议恢复时间、各因子百分比）',
  '- status：训练状态（VO2max、急性/慢性负荷、ACWR、负荷平衡评价）',
  '',
  '规则：',
  '1. 工具调用必须独占一行，整行是合法 JSON，前后不能有任何文字或 markdown 代码块标记',
  '2. 收到工具结果后，用自然语言（中文，简洁，3-5 句）总结回答用户',
  '3. 工具结果可能包含 null 字段，请忽略无数据项',
  '4. 闲聊或通用问题直接用自然语言回复，不要调用工具',
  '5. 同一查询最多 1 次工具调用，避免重复',
].join('\n');

const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 10;
const MAX_TOOL_ROUNDS = 3;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface SessionState {
  messages: ChatMessage[];
  lastUpdated: number;
}

const sessions = new Map<string, SessionState>();

/**
 * 处理用户消息，返回最终回复文本
 */
export async function handleUserMessage(env: WecomChatEnv, userId: string, userText: string): Promise<string> {
  if (!env.AI_API_KEY) {
    return '未配置 AI_API_KEY，对话式助手暂不可用。';
  }
  const aiConfig: AiConfig = {
    apiKey: env.AI_API_KEY,
    baseUrl: env.AI_BASE_URL || 'https://api.deepseek.com',
    model: env.AI_MODEL || 'deepseek-chat',
  };

  const state = getOrCreateSession(userId);
  state.messages.push({ role: 'user', content: userText });
  trimMessages(state);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let reply: string;
    try {
      reply = await callLLM(aiConfig, state.messages);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `AI 调用失败：${msg}`;
    }

    const toolCall = parseToolCall(reply);
    if (!toolCall) {
      // 纯文本回复，收尾
      state.messages.push({ role: 'assistant', content: reply });
      state.lastUpdated = Date.now();
      return reply;
    }

    // 执行工具
    const toolResult = await callGarminTool(env, toolCall.endpoint, toolCall.date);
    // 保留 LLM 决定 + 工具结果，继续下一轮让 LLM 总结
    state.messages.push({ role: 'assistant', content: reply });
    state.messages.push({
      role: 'system',
      content: `工具 ${toolCall.endpoint}(${toolCall.date}) 返回：\n${toolResult}\n\n请基于以上数据用简洁中文回答用户，不要再调用工具。`,
    });
    trimMessages(state);
  }

  // 超过 MAX_TOOL_ROUNDS 仍未收尾，强制最后调用
  const finalReply = await callLLM(aiConfig, [
    ...state.messages,
    { role: 'system', content: '已达到最大工具调用轮数，请直接基于已有信息回答用户，不要再调用工具。' },
  ]);
  state.messages.push({ role: 'assistant', content: finalReply });
  state.lastUpdated = Date.now();
  return finalReply;
}

function getOrCreateSession(userId: string): SessionState {
  const now = Date.now();
  const existing = sessions.get(userId);
  if (existing && now - existing.lastUpdated < SESSION_TTL_MS) {
    existing.lastUpdated = now;
    return existing;
  }
  const fresh: SessionState = {
    messages: [{ role: 'system', content: SYSTEM_PROMPT }],
    lastUpdated: now,
  };
  sessions.set(userId, fresh);
  return fresh;
}

function trimMessages(state: SessionState): void {
  const sys = state.messages[0]?.role === 'system' ? [state.messages[0]] : [];
  const rest = state.messages.slice(sys.length);
  const trimmed = rest.slice(-MAX_HISTORY_MESSAGES);
  state.messages = [...sys, ...trimmed];
}

async function callLLM(config: AiConfig, messages: ChatMessage[]): Promise<string> {
  const resp = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.5,
      messages,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`AI 接口返回 ${resp.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('AI 返回为空');
  return content;
}

interface ParsedToolCall {
  endpoint: GarminEndpoint;
  date: string;
}

/**
 * 从 LLM 回复中解析工具调用
 * 优先尝试整段 JSON，失败则正则提取
 */
function parseToolCall(text: string): ParsedToolCall | null {
  const trimmed = text.trim();
  // 去掉可能被 LLM 包裹的 ```json ... ``` 代码块
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  try {
    const obj = JSON.parse(cleaned) as {
      tool?: string;
      endpoint?: string;
      date?: string;
    };
    if (obj?.tool === 'garmin' && typeof obj.endpoint === 'string' && typeof obj.date === 'string') {
      if (isValidEndpoint(obj.endpoint)) {
        return { endpoint: obj.endpoint, date: obj.date };
      }
    }
  } catch {
    // 整段不是 JSON，继续走正则
  }

  const match = cleaned.match(
    /\{\s*"tool"\s*:\s*"garmin"\s*,\s*"endpoint"\s*:\s*"(sleep|summary|hrv|readiness|status)"\s*,\s*"date"\s*:\s*"([^"]+)"\s*\}/,
  );
  if (match) {
    return { endpoint: match[1] as GarminEndpoint, date: match[2] };
  }
  return null;
}

function isValidEndpoint(s: string): s is GarminEndpoint {
  return s === 'sleep' || s === 'summary' || s === 'hrv' || s === 'readiness' || s === 'status';
}
