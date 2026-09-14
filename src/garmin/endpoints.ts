/**
 * Garmin Connect API 端点定义
 *
 * 注意：数据接口走 connectapi.garmin.com（移动端 API），
 * 而非网页端 connect.garmin.com。
 */

export const GARMIN_DOMAIN = 'garmin.com';

export const GC_MODERN = `https://connect.${GARMIN_DOMAIN}/modern`;
export const GARMIN_SSO_ORIGIN = `https://sso.${GARMIN_DOMAIN}`;
export const GC_API = `https://connectapi.${GARMIN_DOMAIN}`;

/** SSO 登录链 */
export const SSO_EMBED_URL = `${GARMIN_SSO_ORIGIN}/sso/embed`;
export const SSO_SIGNIN_URL = `${GARMIN_SSO_ORIGIN}/sso/signin`;

/** OAuth */
export const OAUTH_URL = `${GC_API}/oauth-service/oauth`;
export const OAUTH_CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json';

/** User-Agent 常量 */
export const USER_AGENT_CONNECTMOBILE = 'com.garmin.android.apps.connectmobile';
export const USER_AGENT_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36';

export const ENDPOINTS = {
  /** 用户资料（用于获取 displayName） */
  socialProfile: '/userprofile-service/socialProfile',

  /** 睡眠报告 */
  sleepData: (date: string) =>
    `/sleep-service/sleep/dailySleepData?date=${date}&nonSleepBufferMinutes=60`,

  /** 每日健康总览 */
  dailySummary: (displayName: string, date: string) =>
    `/usersummary-service/usersummary/daily/${displayName}?calendarDate=${date}`,

  /** 夜间 HRV */
  hrv: (date: string) => `/hrv-service/hrv/${date}`,

  /** 训练准备度 */
  trainingReadiness: (date: string) => `/metrics-service/metrics/trainingreadiness/${date}`,

  /** 训练状态聚合（VO2max / 训练负荷 / ACWR） */
  trainingStatus: (date: string) =>
    `/metrics-service/metrics/trainingstatus/aggregated/${date}`,
} as const;

/**
 * 构建完整 API URL
 */
export function apiUrl(path: string): string {
  return `${GC_API}${path}`;
}
