/**
 * Markdown 报告格式化
 * 兼容 Server酱（desp 支持 Markdown，段落间需要双换行）
 */

import type { ReportData } from './types.js';
import { formatDuration, formatMinutes, arrow, delta } from '../utils/time.js';

const QUALIFIER_MAP: Record<string, string> = {
  EXCELLENT: '优秀',
  GOOD: '良好',
  FAIR: '一般',
  POOR: '差',
  HIGH: '高',
  MODERATE: '中等',
  LOW: '低',
  VERY_LOW: '很低',
  BALANCED: '平衡',
  UNBALANCED: '失衡',
  UNKNOWN: '未知',
};

const STATUS_MAP: Record<string, string> = {
  PRODUCTIVE: '高效训练',
  MAINTAINING: '保持状态',
  RECOVERY: '恢复中',
  UNPRODUCTIVE: '低效训练',
  OVERREACHING: '过度训练',
  STRAINED: '过度疲劳',
  DETRAINING: '停训退步',
  NO_STATUS: '无状态',
};

const ACWR_MAP: Record<string, string> = {
  OPTIMAL: '理想',
  LOW: '偏低',
  HIGH: '偏高',
  VERY_HIGH: '过高',
  VERY_LOW: '过低',
};

const BALANCE_MAP: Record<string, string> = {
  BALANCED: '均衡',
  ABOVE_TARGETS: '高于目标区间',
  BELOW_TARGETS: '低于目标区间',
  LACKING_LOW_AEROBIC: '缺乏低强度有氧',
  HIGH_AEROBIC: '高强度有氧偏多',
  HIGH_ANAEROBIC: '高强度无氧偏多',
};

function qualifier(key: string | null | undefined): string {
  if (!key) return '未知';
  return QUALIFIER_MAP[key] ?? key;
}

/** 训练状态短语形如 PRODUCTIVE_3 / MAINTAINING_1，去掉尾部数字 */
function trainingStatus(key: string | null | undefined): string {
  if (!key) return '未知';
  const base = key.replace(/_\d+$/, '');
  return STATUS_MAP[base] ?? key;
}

function pct(part: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

function row(label: string, value: string | null | undefined, suffix = ''): string {
  if (value === null || value === undefined || value === '') return `- ${label}: N/A`;
  return `- ${label}: ${value}${suffix}`;
}

function formatSleepSection(data: ReportData): string {
  if (data.sleepError) {
    return `## 睡眠（昨晚）

> 拉取失败：${data.sleepError}`;
  }
  const s = data.sleep;
  if (!s) return '## 睡眠（昨晚）\n\n无数据';

  const lines: string[] = ['## 睡眠（昨晚）', ''];
  if (s.overallScore !== null) {
    lines.push(`**总体评分：${s.overallScore}（${qualifier(s.overallQualifier)}）**`);
  }
  lines.push(`总时长 ${formatDuration(s.sleepTimeSeconds)}`);
  if (s.sleepStartLocal && s.sleepEndLocal) {
    lines.push(`时段：${s.sleepStartLocal} → ${s.sleepEndLocal}`);
  }
  lines.push('');
  lines.push('| 阶段 | 时长 | 占比 |');
  lines.push('| --- | --- | --- |');
  lines.push(`| 深睡 | ${formatMinutes(s.deepSleepSeconds)} | ${pct(s.deepSleepSeconds, s.sleepTimeSeconds)} |`);
  lines.push(`| 浅睡 | ${formatMinutes(s.lightSleepSeconds)} | ${pct(s.lightSleepSeconds, s.sleepTimeSeconds)} |`);
  lines.push(`| REM | ${formatMinutes(s.remSleepSeconds)} | ${pct(s.remSleepSeconds, s.sleepTimeSeconds)} |`);
  lines.push(`| 清醒 | ${formatMinutes(s.awakeSleepSeconds)} | ${pct(s.awakeSleepSeconds, s.sleepTimeSeconds)} |`);
  lines.push('');

  const vitals: string[] = [];
  if (s.averageSpO2Value !== null) {
    vitals.push(
      `血氧 ${s.averageSpO2Value}%${s.lowestSpO2Value !== null ? `（最低 ${s.lowestSpO2Value}%）` : ''}`,
    );
  }
  if (s.averageRespirationValue !== null) vitals.push(`呼吸 ${s.averageRespirationValue} 次/分`);
  if (s.avgSleepStress !== null) vitals.push(`睡眠压力 ${s.avgSleepStress}`);
  if (s.restingHeartRate !== null) vitals.push(`静息心率 ${s.restingHeartRate} bpm`);
  if (vitals.length > 0) lines.push(vitals.join(' | '));
  return lines.join('\n');
}

function formatDailySection(data: ReportData): string {
  if (data.dailyError) {
    return `## 每日健康总览

> 拉取失败：${data.dailyError}`;
  }
  const d = data.daily;
  if (!d) return '## 每日健康总览\n\n无数据';

  const lines: string[] = ['## 每日健康总览', ''];
  if (d.steps !== null && d.stepGoal !== null) {
    lines.push(row('步数', `${d.steps} / ${d.stepGoal}`));
  } else if (d.steps !== null) {
    lines.push(row('步数', String(d.steps)));
  }
  if (d.totalDistanceMeters !== null) {
    lines.push(row('距离', (d.totalDistanceMeters / 1000).toFixed(2), ' km'));
  }
  if (d.totalKilocalories !== null) {
    lines.push(row('卡路里', String(d.totalKilocalories), ' kcal'));
    if (d.activeKilocalories !== null) {
      lines.push(row('  其中活动消耗', String(d.activeKilocalories), ' kcal'));
    }
  }
  if (d.moderateIntensityMinutes !== null || d.vigorousIntensityMinutes !== null) {
    const mod = d.moderateIntensityMinutes ?? 0;
    const vig = d.vigorousIntensityMinutes ?? 0;
    const totalMin = mod + vig * 2;
    const goal = d.intensityMinutesGoal ?? 150;
    lines.push(row('强度分钟', `${totalMin} / ${goal}`));
  }
  if (d.restingHeartRate !== null || d.minHeartRate !== null || d.maxHeartRate !== null) {
    const parts: string[] = [];
    if (d.restingHeartRate !== null) parts.push(`静息 ${d.restingHeartRate}`);
    if (d.minHeartRate !== null) parts.push(`最低 ${d.minHeartRate}`);
    if (d.maxHeartRate !== null) parts.push(`最高 ${d.maxHeartRate}`);
    lines.push(row('心率', parts.join(' / '), ' bpm'));
  }
  if (d.averageStressLevel !== null || d.maxStressLevel !== null) {
    const parts: string[] = [];
    if (d.averageStressLevel !== null) parts.push(`平均 ${d.averageStressLevel}`);
    if (d.maxStressLevel !== null) parts.push(`最高 ${d.maxStressLevel}`);
    lines.push(row('压力', parts.join(' / ')));
  }
  if (d.bodyBatteryChargedValue !== null || d.bodyBatteryDrainedValue !== null) {
    const parts: string[] = [];
    if (d.bodyBatteryChargedValue !== null) parts.push(`充电 ${d.bodyBatteryChargedValue}`);
    if (d.bodyBatteryDrainedValue !== null) parts.push(`消耗 ${d.bodyBatteryDrainedValue}`);
    lines.push(row('身体电量', parts.join(' / ')));
  }
  if (d.averageSpo2 !== null || d.lowestSpo2 !== null) {
    const parts: string[] = [];
    if (d.averageSpo2 !== null) parts.push(`平均 ${d.averageSpo2}%`);
    if (d.lowestSpo2 !== null) parts.push(`最低 ${d.lowestSpo2}%`);
    lines.push(row('血氧', parts.join(' / ')));
  }
  return lines.join('\n');
}

function formatHealthSection(data: ReportData): string {
  if (data.healthError) {
    return `## 夜间生理指标

> 拉取失败：${data.healthError}`;
  }
  const h = data.health;
  if (!h) return '';

  const lines: string[] = ['## 夜间生理指标', ''];
  if (h.hrvLastNightAvg !== null) {
    lines.push(
      row('夜间 HRV', String(h.hrvLastNightAvg), `（${qualifier(h.hrvStatus)}）`),
    );
  }
  if (h.hrvWeeklyAvg !== null) lines.push(row('近 7 天平均 HRV', String(h.hrvWeeklyAvg)));
  if (h.hrv5MinHigh !== null) lines.push(row('夜间 5 分钟最高 HRV', String(h.hrv5MinHigh)));
  if (h.hrvBaselineLow !== null && h.hrvBaselineUpper !== null) {
    lines.push(row('基线区间', `${h.hrvBaselineLow} - ${h.hrvBaselineUpper}`));
  }
  return lines.join('\n');
}

function formatTrainingSection(data: ReportData): string {
  const lines: string[] = ['## 训练负荷与恢复', ''];

  if (data.readinessError) {
    lines.push(`> 训练准备度拉取失败：${data.readinessError}`);
  } else if (data.readiness) {
    const r = data.readiness;
    if (r.score !== null) {
      lines.push(`**训练准备度：${r.score}（${qualifier(r.level)}）**`);
    }
    if (r.recoveryTimeMinutes !== null) {
      lines.push(row('建议恢复时间', formatDuration(r.recoveryTimeMinutes * 60)));
    }
    if (r.feedbackShort) lines.push(row('提示', r.feedbackShort));
    const factors: string[] = [];
    if (r.sleepHistoryFactorPercent !== null) factors.push(`睡眠 ${r.sleepHistoryFactorPercent}%`);
    if (r.hrvFactorPercent !== null) factors.push(`HRV ${r.hrvFactorPercent}%`);
    if (r.acwrFactorPercent !== null) factors.push(`负荷比 ${r.acwrFactorPercent}%`);
    if (r.stressHistoryFactorPercent !== null) {
      factors.push(`压力史 ${r.stressHistoryFactorPercent}%`);
    }
    if (factors.length > 0) lines.push(row('影响因子', factors.join(' / ')));
  }

  if (data.trainingError) {
    lines.push(`> 训练状态拉取失败：${data.trainingError}`);
  } else if (data.training) {
    const t = data.training;
    if (lines.length > 2) lines.push('');
    lines.push(`**训练状态：${trainingStatus(t.trainingStatusPhrase)}**`);
    if (t.vo2Max !== null) lines.push(row('VO2max', String(t.vo2Max)));
    if (t.acuteLoad !== null || t.chronicLoad !== null) {
      const parts: string[] = [];
      if (t.acuteLoad !== null) parts.push(`急性 ${t.acuteLoad}`);
      if (t.chronicLoad !== null) parts.push(`慢性 ${t.chronicLoad}`);
      lines.push(row('训练负荷', parts.join(' / ')));
    }
    if (t.acwr !== null) {
      const status = t.acwrStatus ? `（${ACWR_MAP[t.acwrStatus] ?? t.acwrStatus}）` : '';
      lines.push(row('急慢性负荷比', `${t.acwr}${status}`));
    }
    if (t.balancePhrase) {
      lines.push(row('负荷平衡', BALANCE_MAP[t.balancePhrase] ?? t.balancePhrase));
    }
  }

  if (lines.length === 2 && lines[1] === '') lines.push('无数据');
  return lines.join('\n');
}

function formatTrendsSection(data: ReportData): string {
  if (data.trends.length === 0) return '';
  const lines: string[] = [
    '## 周度趋势对比',
    '',
    '| 指标 | 7天前 | 今日 | 变化 |',
    '| --- | --- | --- | --- |',
  ];
  for (const t of data.trends) {
    const old = t.sevenDaysAgo !== null ? String(t.sevenDaysAgo) : 'N/A';
    const now = t.today !== null ? String(t.today) : 'N/A';
    lines.push(`| ${t.metric} | ${old} | ${now} | ${t.delta} |`);
  }
  return lines.join('\n');
}

export function formatReport(data: ReportData): string {
  const parts: string[] = [];
  parts.push(`# Garmin 日报 ${data.date}`);
  parts.push('');
  parts.push(formatSleepSection(data));
  parts.push('');
  parts.push(formatDailySection(data));
  parts.push('');
  const health = formatHealthSection(data);
  if (health) {
    parts.push(health);
    parts.push('');
  }
  parts.push(formatTrainingSection(data));
  parts.push('');
  const trends = formatTrendsSection(data);
  if (trends) {
    parts.push(trends);
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * 格式化周度趋势对比项（用于 pipeline.ts 构建 trends 数组）
 */
export function buildTrend(
  metric: string,
  sevenDaysAgo: number | null,
  today: number | null,
): { metric: string; sevenDaysAgo: number | null; today: number | null; delta: string } {
  if (sevenDaysAgo === null || today === null) {
    return { metric, sevenDaysAgo, today, delta: 'N/A' };
  }
  const arr = arrow(today, sevenDaysAgo);
  const d = delta(today, sevenDaysAgo);
  return { metric, sevenDaysAgo, today, delta: `${arr} ${d}` };
}
