/**
 * Cloudflare Workers 入口
 *
 * - 由 Cron Triggers 触发（wrangler.toml 中配置 UTC 23:30 = 北京 07:30）
 * - 也可手动 GET /run 触发，便于调试
 *
 * 依赖 secrets：GARMIN_USERNAME / GARMIN_PASSWORD / SERVERCHAN_SENDKEY
 */

import { runPipeline, type PipelineResult } from './pipeline.js';

interface Env {
  GARMIN_USERNAME: string;
  GARMIN_PASSWORD: string;
  SERVERCHAN_SENDKEY: string;
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
  if (!env.GARMIN_USERNAME || !env.GARMIN_PASSWORD) {
    throw new Error('缺少 GARMIN_USERNAME / GARMIN_PASSWORD secret');
  }
  return runPipeline({
    username: env.GARMIN_USERNAME,
    password: env.GARMIN_PASSWORD,
    sendKey: env.SERVERCHAN_SENDKEY,
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
