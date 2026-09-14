/**
 * Node 入口（本地运行 / GitHub Actions）
 *
 * 用法：npm start  （需要 .env 中配置 GARMIN_USERNAME / GARMIN_PASSWORD / SERVERCHAN_SENDKEY）
 */

import 'dotenv/config';
import process from 'node:process';
import { runPipeline } from './pipeline.js';
import { pushReport as pushFtqq } from './notify/ftqq.js';
import { pushReport as pushWecom } from './notify/wecom.js';
import type { AiConfig } from './ai/advice.js';

async function main(): Promise<void> {
  const username = process.env.GARMIN_USERNAME;
  const password = process.env.GARMIN_PASSWORD;
  const sendKey = process.env.SERVERCHAN_SENDKEY;
  const wecomKey = process.env.WECOM_BOT_KEY;
  // CI 推荐：本机 `npm run token` 生成，绕开 sso.garmin.com 对机房 IP 的风控
  const oauth1Token = process.env.GARMIN_OAUTH1_TOKEN
    ? {
        key: process.env.GARMIN_OAUTH1_TOKEN,
        secret: process.env.GARMIN_OAUTH1_TOKEN_SECRET,
      }
    : undefined;

  // 可选：AI 分析（缺 API key 则跳过）
  let ai: AiConfig | undefined;
  if (process.env.AI_API_KEY) {
    ai = {
      apiKey: process.env.AI_API_KEY,
      baseUrl: process.env.AI_BASE_URL || 'https://api.deepseek.com',
      model: process.env.AI_MODEL || 'deepseek-chat',
    };
  }

  if (!oauth1Token && (!username || !password)) {
    throw new Error(
      '缺少凭据：请配置 GARMIN_USERNAME / GARMIN_PASSWORD，或配置 GARMIN_OAUTH1_TOKEN（+GARMIN_OAUTH1_TOKEN_SECRET）',
    );
  }

  console.log('[main] 开始执行 Garmin 每日报告任务');
  const result = await runPipeline({
    username: username ?? '',
    password: password ?? '',
    oauth1Token,
    sendKey,
    wecomKey,
    ai,
    dryRun: process.env.DRY_RUN === '1',
    log: (msg) => console.log(msg),
  });

  console.log('[main] 报告内容：\n---');
  console.log(result.report);
  console.log('---');

  if (result.push && !result.push.success) {
    process.exitCode = 1;
  }
  if (result.pushWecom && !result.pushWecom.success) {
    process.exitCode = 1;
  }
  console.log('[main] 任务完成');
}

main().catch(async (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[main] 未捕获错误：${msg}`);
  // 认证失败时 pipeline 已推送过通知，避免重复推送
  const alreadyNotified = err instanceof Error && err.name === 'GarminAuthError';
  if (!alreadyNotified) {
    const body = `任务异常退出：\n\n${msg}`;
    try {
      if (process.env.SERVERCHAN_SENDKEY) {
        await pushFtqq(process.env.SERVERCHAN_SENDKEY, 'Garmin 日报任务异常', body);
      }
    } catch {
      // 推送本身也失败，已无路可走
    }
    try {
      if (process.env.WECOM_BOT_KEY) {
        await pushWecom(process.env.WECOM_BOT_KEY, 'Garmin 日报任务异常', body);
      }
    } catch {
      // 推送本身也失败，已无路可走
    }
  }
  process.exitCode = 1;
});
