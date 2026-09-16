/**
 * Garmin 数据 + 报告类型定义
 *
 * 字段命名对齐 connectapi.garmin.com 的真实响应结构。
 */

/** 睡眠报告（/sleep-service/sleep/dailySleepData） */
export interface SleepData {
  date: string;
  /** 总体评分 */
  overallScore: number | null;
  /** EXCELLENT / GOOD / FAIR / POOR */
  overallQualifier: string | null;
  /** 睡眠时长（秒） */
  sleepTimeSeconds: number;
  deepSleepSeconds: number;
  lightSleepSeconds: number;
  remSleepSeconds: number;
  awakeSleepSeconds: number;
  /** 入睡 / 醒来时间（Asia/Shanghai 本地时间字符串） */
  sleepStartLocal: string | null;
  sleepEndLocal: string | null;
  /** 夜间生理 */
  averageSpO2Value: number | null;
  lowestSpO2Value: number | null;
  averageRespirationValue: number | null;
  avgSleepStress: number | null;
  restingHeartRate: number | null;
  bodyBatteryChange: number | null;
  /** 各阶段占比（%） */
  deepPercentage: number | null;
  remPercentage: number | null;
  lightPercentage: number | null;
}

/** 每日健康总览（/usersummary-service/usersummary/daily/{displayName}） */
export interface DailySummary {
  date: string;
  steps: number | null;
  stepGoal: number | null;
  totalDistanceMeters: number | null;
  totalKilocalories: number | null;
  activeKilocalories: number | null;
  bmrKilocalories: number | null;
  /** 强度分钟 */
  moderateIntensityMinutes: number | null;
  vigorousIntensityMinutes: number | null;
  intensityMinutesGoal: number | null;
  /** 心率 */
  minHeartRate: number | null;
  restingHeartRate: number | null;
  maxHeartRate: number | null;
  /** 压力 */
  averageStressLevel: number | null;
  maxStressLevel: number | null;
  /** 身体电量 */
  bodyBatteryChargedValue: number | null;
  bodyBatteryDrainedValue: number | null;
  /** 血氧 */
  averageSpo2: number | null;
  lowestSpo2: number | null;
}

/** 夜间 HRV（/hrv-service/hrv/{date}） */
export interface HealthMetrics {
  date: string;
  /** BALANCED / LOW / HIGH / UNBALANCED */
  hrvStatus: string | null;
  /** 昨晚平均 HRV */
  hrvLastNightAvg: number | null;
  /** 近 7 天平均 HRV */
  hrvWeeklyAvg: number | null;
  /** 夜间 5 分钟最高 HRV */
  hrv5MinHigh: number | null;
  /** 基线区间 */
  hrvBaselineLow: number | null;
  hrvBaselineUpper: number | null;
}

/** 训练准备度（/metrics-service/metrics/trainingreadiness/{date}） */
export interface TrainingReadiness {
  date: string;
  /** 准备度评分 0-100 */
  score: number | null;
  /** HIGH / MODERATE / LOW / VERY_LOW */
  level: string | null;
  feedbackShort: string | null;
  feedbackLong: string | null;
  /** 建议恢复时间（分钟） */
  recoveryTimeMinutes: number | null;
  sleepScore: number | null;
  /** 急性训练负荷 */
  acuteLoad: number | null;
  hrvWeeklyAverage: number | null;
  /** 各项因子（%） */
  acwrFactorPercent: number | null;
  stressHistoryFactorPercent: number | null;
  sleepHistoryFactorPercent: number | null;
  hrvFactorPercent: number | null;
}

/** 训练状态（/metrics-service/metrics/trainingstatus/aggregated/{date}） */
export interface TrainingStatus {
  date: string;
  vo2Max: number | null;
  /** 例如 PRODUCTIVE_3 / MAINTAINING_1 */
  trainingStatusPhrase: string | null;
  /** 急性负荷（约等于 ATL） */
  acuteLoad: number | null;
  /** 慢性负荷（约等于 CTL） */
  chronicLoad: number | null;
  /** 急慢性负荷比（ACWR） */
  acwr: number | null;
  acwrStatus: string | null;
  /** 训练负荷平衡评价，例如 ABOVE_TARGETS */
  balancePhrase: string | null;
  deviceName: string | null;
}

/** 周度趋势对比项 */
export interface WeeklyTrend {
  metric: string;
  sevenDaysAgo: number | null;
  today: number | null;
  delta: string;
}

/** 体重/体成分（iPhone 推送存 KV，日报展示用） */
export interface WeightData {
  /** 测量时刻的本地日期（YYYY-MM-DD，Asia/Shanghai） */
  displayDate: string;
  /** 测量时刻本地时间（HH:mm） */
  measuredAtLocal: string;
  /** 体重（kg） */
  weightKg: number;
  /** 体脂率（%） */
  bodyFatRate?: number;
  /** BMI */
  bmi?: number;
  /** 肌肉量（kg） */
  muscleMassKg?: number;
  /** 7 天前体重（kg），用于变化展示 */
  sevenDaysAgoKg?: number;
}

/** 报告所需的全部数据 */
export interface ReportData {
  date: string;
  sleep: SleepData | null;
  sleepError: string | null;
  daily: DailySummary | null;
  dailyError: string | null;
  health: HealthMetrics | null;
  healthError: string | null;
  readiness: TrainingReadiness | null;
  readinessError: string | null;
  training: TrainingStatus | null;
  trainingError: string | null;
  trends: WeeklyTrend[];
  /** 体重/体成分，未配置 KV 或无数据为 null */
  weight: WeightData | null;
}
