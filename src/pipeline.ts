/**
 * 共享编排流程（Node 与 Cloudflare Workers 共用）
 *
 * 流程：登录 → 拉取当日 + 7 天前数据 → 构建趋势 → 生成 Markdown → 推送 Server酱
 *
 * 仅依赖 fetch 与 Web Crypto，可在 Node >= 20 与 Workers 运行时执行。
 */

import { GarminAuth } from './garmin/auth.js';
import { GarminApi } from './garmin/api.js';
import { formatReport, buildTrend } from './report/formatter.js';
import { pushReport, type PushResult } from './notify/ftqq.js';
import { today, daysAgo } from './utils/time.js';
import type { ReportData, WeeklyTrend } from './report/types.js';

export interface PipelineConfig {
  /** Garmin 账号 */
  username: string;
  password: string;
  /** Server酱 SendKey，缺省则只生成报告不推送 */
  sendKey?: string;
  /**
   * 长效 OAuth1 token（本机 `npm run token` 生成）。
   * 提供时跳过 SSO 账号密码登录，用于 sso.garmin.com 被风控的 CI 环境。
   */
  oauth1Token?: { key: string; secret?: string };
  /** 目标日期（YYYY-MM-DD），默认今天（Asia/Shanghai） */
  date?: string;
  /** 只生成不推送 */
  dryRun?: boolean;
  log?: (message: string) => void;
}

export interface PipelineResult {
  date: string;
  title: string;
  report: string;
  push: PushResult | null;
}

/** 秒 → 小时（保留 1 位），0 视为无数据 */
function hours(seconds: number | null | undefined): number | null {
  if (!seconds) return null;
  return +(seconds / 3600).toFixed(1);
}

export async function runPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const log = config.log ?? (() => {});
  const date = config.date ?? today();
  const date7Ago = daysAgo(7);

  const auth = new GarminAuth(log);
  try {
    if (config.oauth1Token?.key) {
      await auth.loginWithOauth1(config.oauth1Token);
    } else {
      await auth.login(config.username, config.password);
    }
    await auth.getProfile();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[pipeline] 认证失败：${msg}`);
    if (config.sendKey && !config.dryRun) {
      await pushReport(config.sendKey, 'Garmin 日报登录失败', `登录失败：${msg}\n\n请检查账号密码或是否触发了两步验证。`);
    }
    throw err;
  }

  const api = new GarminApi(auth);

  log('[pipeline] 拉取当日数据');
  const [sleepP, dailyP, healthP, readinessP, trainingP] = await Promise.allSettled([
    api.getSleep(date),
    api.getDailySummary(date),
    api.getHealthMetrics(date),
    api.getTrainingReadiness(date),
    api.getTrainingStatus(date),
  ]);

  const settled = <T>(r: PromiseSettledResult<T>) =>
    r.status === 'fulfilled'
      ? { value: r.value, error: null }
      : { value: null, error: r.reason instanceof Error ? r.reason.message : String(r.reason) };

  const sleep = settled(sleepP);
  const daily = settled(dailyP);
  const health = settled(healthP);
  const readiness = settled(readinessP);
  const training = settled(trainingP);

  log(`[pipeline] 拉取 7 天前（${date7Ago}）数据用于趋势对比`);
  const [sleep7P, daily7P, health7P] = await Promise.allSettled([
    api.getSleep(date7Ago),
    api.getDailySummary(date7Ago),
    api.getHealthMetrics(date7Ago),
  ]);
  const sleep7 = settled(sleep7P).value;
  const daily7 = settled(daily7P).value;
  const health7 = settled(health7P).value;

  const trends: WeeklyTrend[] = [];
  if (sleep.value && sleep7) {
    trends.push(buildTrend('总睡眠(小时)', hours(sleep7.sleepTimeSeconds), hours(sleep.value.sleepTimeSeconds)));
    if (sleep7.overallScore !== null && sleep.value.overallScore !== null) {
      trends.push(buildTrend('睡眠评分', sleep7.overallScore, sleep.value.overallScore));
    }
  }
  if (daily.value && daily7) {
    trends.push(buildTrend('静息心率(bpm)', daily7.restingHeartRate, daily.value.restingHeartRate));
    trends.push(buildTrend('步数', daily7.steps, daily.value.steps));
  }
  if (health.value && health7) {
    trends.push(buildTrend('夜间HRV', health7.hrvLastNightAvg, health.value.hrvLastNightAvg));
  }

  const reportData: ReportData = {
    date,
    sleep: sleep.value,
    sleepError: sleep.error,
    daily: daily.value,
    dailyError: daily.error,
    health: health.value,
    healthError: health.error,
    readiness: readiness.value,
    readinessError: readiness.error,
    training: training.value,
    trainingError: training.error,
    trends,
  };

  const report = formatReport(reportData);
  const title = `Garmin 日报 ${date}`;

  if (!config.sendKey || config.dryRun) {
    log('[pipeline] 未配置 SendKey 或已开启 dryRun，跳过推送');
    return { date, title, report, push: null };
  }

  log('[pipeline] 推送到 Server酱');
  const push = await pushReport(config.sendKey, title, report);
  log(`[pipeline] 推送结果：${push.success ? '成功' : `失败 - ${push.message}`}`);
  return { date, title, report, push };
}
