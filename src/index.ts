/**
 * Node 入口（本地运行 / GitHub Actions）
 *
 * 用法：npm start  （需要 .env 中配置 GARMIN_USERNAME / GARMIN_PASSWORD / SERVERCHAN_SENDKEY）
 */

import 'dotenv/config';
import process from 'node:process';
import { runPipeline } from './pipeline.js';
import { pushReport } from './notify/ftqq.js';

async function main(): Promise<void> {
  const username = process.env.GARMIN_USERNAME;
  const password = process.env.GARMIN_PASSWORD;
  const sendKey = process.env.SERVERCHAN_SENDKEY;

  if (!username || !password) {
    throw new Error('缺少 GARMIN_USERNAME / GARMIN_PASSWORD 环境变量');
  }

  console.log('[main] 开始执行 Garmin 每日报告任务');
  const result = await runPipeline({
    username,
    password,
    sendKey,
    dryRun: process.env.DRY_RUN === '1',
    log: (msg) => console.log(msg),
  });

  console.log('[main] 报告内容：\n---');
  console.log(result.report);
  console.log('---');

  if (result.push && !result.push.success) {
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
    try {
      await pushReport(process.env.SERVERCHAN_SENDKEY, 'Garmin 日报任务异常', `任务异常退出：\n\n${msg}`);
    } catch {
      // 推送本身也失败，已无路可走
    }
  }
  process.exitCode = 1;
});
