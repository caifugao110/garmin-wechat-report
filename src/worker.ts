/**
 * Cloudflare Workers 入口
 *
 * - 由 Cron Triggers 触发（wrangler.toml 中配置 UTC 23:30 = 北京 07:30）
 * - 也可手动 GET /run 触发，便于调试
 *
 * 依赖 secrets：GARMIN_USERNAME / GARMIN_PASSWORD / SERVERCHAN_SENDKEY
 * 可选 secrets：GARMIN_OAUTH1_TOKEN / WECOM_BOT_KEY / AI_API_KEY
 * 非敏感配置（AI_BASE_URL / AI_MODEL）可直接写入 wrangler.toml 的 [vars] 段
 */

import { runPipeline, type PipelineResult } from './pipeline.js';
import type { AiConfig } from './ai/advice.js';

interface Env {
  GARMIN_USERNAME?: string;
  GARMIN_PASSWORD?: string;
  SERVERCHAN_SENDKEY?: string;
  /** 可选：长效 OAuth1 token，配置后跳过 SSO 登录 */
  GARMIN_OAUTH1_TOKEN?: string;
  GARMIN_OAUTH1_TOKEN_SECRET?: string;
  /** 可选：企业微信群机器人 Webhook key */
  WECOM_BOT_KEY?: string;
  /** 可选：AI 分析，缺 API key 则跳过 */
  AI_API_KEY?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

async function run(env: Env, date?: string): Promise<PipelineResult> {
  const oauth1Token = env.GARMIN_OAUTH1_TOKEN
    ? { key: env.GARMIN_OAUTH1_TOKEN, secret: env.GARMIN_OAUTH1_TOKEN_SECRET }
    : undefined;

  let ai: AiConfig | undefined;
  if (env.AI_API_KEY) {
    ai = {
      apiKey: env.AI_API_KEY,
      baseUrl: env.AI_BASE_URL || 'https://api.deepseek.com',
      model: env.AI_MODEL || 'deepseek-chat',
    };
  }

  if (!oauth1Token && (!env.GARMIN_USERNAME || !env.GARMIN_PASSWORD)) {
    throw new Error('缺少凭据：请配置 GARMIN_USERNAME/GARMIN_PASSWORD 或 GARMIN_OAUTH1_TOKEN');
  }
  return runPipeline({
    username: env.GARMIN_USERNAME ?? '',
    password: env.GARMIN_PASSWORD ?? '',
    oauth1Token,
    sendKey: env.SERVERCHAN_SENDKEY,
    wecomKey: env.WECOM_BOT_KEY,
    ai,
    date,
    log: (msg) => console.log(msg),
  });
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(run(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/run') {
      return new Response('Garmin 日报 Worker 运行中。访问 /run 手动触发，?date=YYYY-MM-DD 指定日期。', {
        status: 200,
      });
    }

    try {
      const result = await run(env, url.searchParams.get('date') ?? undefined);
      return new Response(result.report, {
        headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`执行失败：${msg}`, { status: 500 });
    }
  },
};
