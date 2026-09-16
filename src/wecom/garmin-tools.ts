/**
 * Garmin 工具调用薄封装
 *
 * 给对话式 AI 提供 5 个可调度的 Garmin 数据查询工具：
 * - sleep      昨晚睡眠报告
 * - summary    每日健康总览（步数/心率/压力/身体电量等）
 * - hrv        夜间 HRV
 * - readiness  训练准备度
 * - status     训练状态（VO2max / 急慢性负荷 / ACWR）
 *
 * 复用 src/garmin/auth.ts 的 OAuth1 登录路径与 src/garmin/api.ts 的 GarminApi。
 * GarminAuth + displayName 在 isolate 内缓存，避免每次对话重复登录。
 */

import { GarminAuth, GarminAuthError } from '../garmin/auth.js';
import { GarminApi } from '../garmin/api.js';
import { today, daysAgo } from '../utils/time.js';
import type { WecomChatEnv } from './types.js';

export type GarminEndpoint = 'sleep' | 'summary' | 'hrv' | 'readiness' | 'status';

interface CachedSession {
  auth: GarminAuth;
  api: GarminApi;
}

let session: CachedSession | null = null;

/**
 * 把工具调用的 endpoint + date 解析成实际日期字符串
 *
 * - today     → 今日
 * - yesterday  → 昨日
 * - YYYY-MM-DD → 原样
 * - 其他/空    → 默认 yesterday（与日报一致：跑出来的数据是昨天的）
 */
export function resolveDate(input: string | null | undefined): string {
  if (!input) return daysAgo(1);
  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'today') return today();
  if (trimmed === 'yesterday') return daysAgo(1);
  // 简单格式校验，失败回退到 yesterday
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  return daysAgo(1);
}

/**
 * 工具调用主入口
 *
 * @returns LLM 友好的 JSON 文本；登录失败/未配置 token 时返回错误说明
 */
export async function callGarminTool(
  env: WecomChatEnv,
  endpoint: GarminEndpoint,
  dateInput: string | null | undefined,
): Promise<string> {
  if (!env.GARMIN_OAUTH1_TOKEN) {
    return 'ERROR: 未配置 GARMIN_OAUTH1_TOKEN，对话式查询暂不可用。请先执行 `npm run token` 生成长效 OAuth1 token 并配置到 Worker secrets。';
  }

  let api: GarminApi;
  try {
    api = await getApi(env);
  } catch (err) {
    session = null;
    const msg = err instanceof Error ? err.message : String(err);
    return `ERROR: Garmin 登录失败：${msg}`;
  }

  const date = resolveDate(dateInput);

  try {
    switch (endpoint) {
      case 'sleep':
        return JSON.stringify(await api.getSleep(date));
      case 'summary':
        return JSON.stringify(await api.getDailySummary(date));
      case 'hrv':
        return JSON.stringify(await api.getHealthMetrics(date));
      case 'readiness':
        return JSON.stringify(await api.getTrainingReadiness(date));
      case 'status':
        return JSON.stringify(await api.getTrainingStatus(date));
      default:
        return `ERROR: 未知 endpoint：${endpoint as string}`;
    }
  } catch (err) {
    // 401 类错误清掉 session，下次重试会重登
    if (err instanceof GarminAuthError && /401|未登录|access_token/.test(err.message)) {
      session = null;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return `ERROR: 调用 ${endpoint}(${date}) 失败：${msg}`;
  }
}

async function getApi(env: WecomChatEnv): Promise<GarminApi> {
  if (session) return session.api;
  const auth = new GarminAuth();
  await auth.loginWithOauth1({
    key: env.GARMIN_OAUTH1_TOKEN!,
    secret: env.GARMIN_OAUTH1_TOKEN_SECRET,
  });
  await auth.getProfile();
  const api = new GarminApi(auth);
  session = { auth, api };
  return api;
}
