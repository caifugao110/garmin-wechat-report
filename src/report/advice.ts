/**
 * 本地规则引擎：根据结构化 ReportData 生成「今日建议」
 *
 * 特点：
 * - 纯函数、零依赖、不发送任何数据到外部服务，Node 与 Cloudflare Workers 均可运行
 * - 阈值参考 README「数据怎么看」一节的通用健康常识，可按个人情况自行调整
 * - 只返回建议文案数组（不含 Markdown 前缀），由 formatter.ts 负责渲染
 * - 每条建议带优先级，最终按优先级排序并截断，确保最重要的告警不被淹没
 */

import type { ReportData, WeeklyTrend } from './types.js';

/** 报告中最多展示的建议条数，避免微信消息过长 */
const MAX_TIPS = 6;

/** 数值越小优先级越高 */
const PRIORITY = {
  /** 血氧等需要医疗关注的异常 */
  CRITICAL: 0,
  /** HRV、训练准备度、负荷比等恢复相关告警 */
  RECOVERY: 1,
  /** 睡眠不足、评分低、压力偏高等健康告警 */
  HEALTH: 2,
  /** 步数等活动量提示与周度趋势提醒 */
  LIFESTYLE: 3,
  /** 状态良好时的正向反馈 */
  POSITIVE: 4,
} as const;

interface Tip {
  priority: number;
  text: string;
}

function findTrend(trends: WeeklyTrend[], metric: string): WeeklyTrend | undefined {
  return trends.find((item) => item.metric === metric);
}

/**
 * 根据当日数据与周度趋势生成建议。
 * 无任何数据时返回空数组（调用方据此不渲染区块）。
 */
export function generateAdvice(data: ReportData): string[] {
  const tips: Tip[] = [];
  const { sleep, daily, health, readiness, training, trends } = data;
  const hasData = Boolean(sleep || daily || health || readiness || training);

  // —— 睡眠 ——
  if (sleep) {
    const sleepHours = sleep.sleepTimeSeconds / 3600;
    if (sleep.sleepTimeSeconds > 0 && sleepHours < 6) {
      tips.push({
        priority: PRIORITY.HEALTH,
        text: `昨晚仅睡 ${sleepHours.toFixed(1)} 小时（不足 6 小时），建议今天安排午休并提前入睡。`,
      });
    }
    if (sleep.overallScore !== null && sleep.overallScore < 60) {
      tips.push({
        priority: PRIORITY.HEALTH,
        text: '睡眠评分低于 60，若连续出现请排查作息不规律、饮酒或睡前压力。',
      });
    }
    const total = sleep.sleepTimeSeconds;
    if (total > 0) {
      if (sleep.deepSleepSeconds / total < 0.13) {
        tips.push({
          priority: PRIORITY.LIFESTYLE,
          text: '深睡占比偏低，睡前避免饮酒与剧烈运动，保持规律作息。',
        });
      }
      if (sleep.remSleepSeconds / total < 0.18) {
        tips.push({
          priority: PRIORITY.LIFESTYLE,
          text: 'REM 睡眠偏少，常与总时长不足有关，尽量睡够 7 小时。',
        });
      }
      if (sleep.awakeSleepSeconds / total > 0.1) {
        tips.push({
          priority: PRIORITY.LIFESTYLE,
          text: '夜间清醒占比偏高，注意改善卧室的温度、光线与噪音。',
        });
      }
    }
    if (sleep.avgSleepStress !== null && sleep.avgSleepStress > 40) {
      tips.push({
        priority: PRIORITY.HEALTH,
        text: '睡眠期间压力水平偏高，夜间恢复可能不充分，今天适当降低运动强度。',
      });
    }
    if (sleep.lowestSpO2Value !== null && sleep.lowestSpO2Value < 90) {
      tips.push({
        priority: PRIORITY.CRITICAL,
        text: '昨晚血氧最低值低于 90%。手表数据可能有误差，若反复出现建议用医疗设备复测并咨询医生。',
      });
    }
  }

  // —— HRV（优先与个人基线比较）——
  if (health) {
    if (
      health.hrvLastNightAvg !== null &&
      health.hrvBaselineLow !== null &&
      health.hrvLastNightAvg < health.hrvBaselineLow
    ) {
      tips.push({
        priority: PRIORITY.RECOVERY,
        text: '夜间 HRV 低于个人基线区间，提示恢复不足或压力累积，注意减压早睡。',
      });
    } else if (health.hrvStatus === 'UNBALANCED') {
      tips.push({
        priority: PRIORITY.RECOVERY,
        text: 'HRV 状态显示失衡，结合睡眠与压力综合观察，避免叠加高强度训练。',
      });
    }
  }

  // —— 训练准备度 ——
  if (readiness && readiness.score !== null) {
    if (readiness.score < 50) {
      tips.push({
        priority: PRIORITY.RECOVERY,
        text: `训练准备度 ${readiness.score} 偏低，今天以散步、轻松骑行或拉伸等恢复性活动为主。`,
      });
    } else if (readiness.score >= 80) {
      tips.push({
        priority: PRIORITY.POSITIVE,
        text: `训练准备度 ${readiness.score}，状态良好，适合安排高质量或高强度训练。`,
      });
    }
  }

  // —— 训练负荷 ——
  if (training) {
    const acwrHigh =
      training.acwrStatus === 'VERY_HIGH' ||
      training.acwrStatus === 'HIGH' ||
      (training.acwr !== null && training.acwr > 1.5);
    const acwrLow =
      training.acwrStatus === 'VERY_LOW' ||
      training.acwrStatus === 'LOW' ||
      (training.acwr !== null && training.acwr < 0.8);
    if (acwrHigh) {
      tips.push({
        priority: PRIORITY.RECOVERY,
        text: '急慢性负荷比（ACWR）偏高，短期伤病风险上升，建议减量并安排恢复。',
      });
    } else if (acwrLow) {
      tips.push({
        priority: PRIORITY.LIFESTYLE,
        text: '训练负荷偏低，长期如此体能可能退步，可在身体允许时逐步增加训练量。',
      });
    }
    const statusBase = training.trainingStatusPhrase?.replace(/_\d+$/, '');
    if (statusBase === 'OVERREACHING' || statusBase === 'STRAINED') {
      tips.push({
        priority: PRIORITY.RECOVERY,
        text: '训练状态提示过度负荷，建议安排减量周，优先保证睡眠与营养。',
      });
    }
  }

  // —— 每日总览 ——
  if (daily) {
    if (daily.steps !== null && daily.stepGoal !== null && daily.steps < daily.stepGoal * 0.5) {
      tips.push({
        priority: PRIORITY.LIFESTYLE,
        text: '步数不足目标的一半，可安排饭后散步 20–30 分钟。',
      });
    }
    if (daily.averageStressLevel !== null && daily.averageStressLevel > 50) {
      tips.push({
        priority: PRIORITY.HEALTH,
        text: '全天平均压力偏高，安排几次深呼吸或短时放松，避免过量咖啡因。',
      });
    }
    if (daily.bodyBatteryChargedValue !== null && daily.bodyBatteryChargedValue < 50) {
      tips.push({
        priority: PRIORITY.RECOVERY,
        text: '身体电量充电不足 50，夜间恢复不充分，高强度训练建议顺延。',
      });
    }
    if (daily.lowestSpo2 !== null && daily.lowestSpo2 < 90) {
      tips.push({
        priority: PRIORITY.CRITICAL,
        text: '今日血氧最低值低于 90%，若多次稳定出现请及时用医疗设备复测并咨询医生。',
      });
    }
  }

  // —— 周度趋势（与 7 天前对比）——
  const rhrTrend = findTrend(trends, '静息心率(bpm)');
  if (
    rhrTrend &&
    rhrTrend.sevenDaysAgo !== null &&
    rhrTrend.today !== null &&
    rhrTrend.today - rhrTrend.sevenDaysAgo >= 5
  ) {
    tips.push({
      priority: PRIORITY.RECOVERY,
      text: '静息心率较 7 天前上升超过 5 bpm，警惕疲劳、压力或感冒早期信号。',
    });
  }

  const hrvTrend = findTrend(trends, '夜间HRV');
  if (
    hrvTrend &&
    hrvTrend.sevenDaysAgo !== null &&
    hrvTrend.today !== null &&
    hrvTrend.sevenDaysAgo > 0 &&
    hrvTrend.today < hrvTrend.sevenDaysAgo * 0.85
  ) {
    tips.push({
      priority: PRIORITY.RECOVERY,
      text: '夜间 HRV 较 7 天前下降超过 15%，恢复状态走弱，注意减轻负荷。',
    });
  }

  const sleepTrend = findTrend(trends, '总睡眠(小时)');
  if (
    sleepTrend &&
    sleepTrend.sevenDaysAgo !== null &&
    sleepTrend.today !== null &&
    sleepTrend.sevenDaysAgo - sleepTrend.today >= 1.5
  ) {
    tips.push({
      priority: PRIORITY.HEALTH,
      text: '总睡眠时长较 7 天前减少超过 1.5 小时，留意睡眠债累积，今晚适当早睡。',
    });
  }

  if (!hasData) return [];
  if (tips.length === 0) {
    return ['各项核心指标整体平稳，保持规律作息、均衡饮食与训练节奏。'];
  }
  tips.sort((a, b) => a.priority - b.priority);
  return tips.slice(0, MAX_TIPS).map((tip) => tip.text);
}
