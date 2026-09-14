/**
 * 时区与日期工具：所有日期基于 Asia/Shanghai，输出 YYYY-MM-DD
 */

const SHANGHAI_TZ = 'Asia/Shanghai';

/**
 * 将 Date 格式化为指定时区的 YYYY-MM-DD 字符串
 */
export function formatDate(date: Date, tz: string = SHANGHAI_TZ): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * 获取指定时区的当前日期
 */
export function today(tz: string = SHANGHAI_TZ): string {
  return formatDate(new Date(), tz);
}

/**
 * 获取 n 天前的日期（基于当前时区）
 */
export function daysAgo(n: number, tz: string = SHANGHAI_TZ): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatDate(d, tz);
}

/**
 * 把秒数格式化为 "X小时Y分钟"
 */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}分钟`;
  if (m === 0) return `${h}小时`;
  return `${h}小时${m}分钟`;
}

/**
 * 将 Garmin 的「本地墙上时间按 UTC 编码」的时间戳格式化为 HH:mm
 *
 * 说明：sleepStartTimestampLocal / sleepEndTimestampLocal 等字段的毫秒值
 * 必须用 UTC 时区解读，才能还原出用户所在时区的真实本地时间。
 * 例：1789344005000 -> UTC 解读为 2026-09-14 00:00，即本地起床前的入睡时刻。
 */
export function formatClock(timestamp: number | null | undefined): string | null {
  if (timestamp === null || timestamp === undefined) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

/**
 * 把秒数格式化为 "X分"
 */
export function formatMinutes(seconds: number): string {
  return `${Math.round(seconds / 60)}分钟`;
}

/**
 * 计算变化箭头
 */
export function arrow(current: number, previous: number): string {
  if (current > previous) return '↑';
  if (current < previous) return '↓';
  return '→';
}

/**
 * 计算百分比变化（绝对值，保留1位小数）
 */
export function delta(current: number, previous: number): string {
  const d = current - previous;
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toFixed(1)}`;
}
