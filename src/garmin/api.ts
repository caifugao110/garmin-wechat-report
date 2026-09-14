/**
 * Garmin Connect API 调用模块
 *
 * 直接使用 fetch 访问 connectapi.garmin.com（移动端 API），
 * 通过 GarminAuth 注入 Bearer 令牌，无浏览器依赖。
 */

import type { GarminAuth } from './auth.js';
import { ENDPOINTS } from './endpoints.js';
import { formatClock } from '../utils/time.js';
import type {
  SleepData,
  DailySummary,
  HealthMetrics,
  TrainingReadiness,
  TrainingStatus,
} from '../report/types.js';

/** 只声明用到的字段 */
interface RawSleepResponse {
  dailySleepDTO?: {
    sleepTimeSeconds?: number;
    deepSleepSeconds?: number;
    lightSleepSeconds?: number;
    remSleepSeconds?: number;
    awakeSleepSeconds?: number;
    sleepStartTimestampLocal?: number;
    sleepEndTimestampLocal?: number;
    averageSpO2Value?: number;
    lowestSpO2Value?: number;
    averageRespirationValue?: number;
    avgSleepStress?: number;
    restingHeartRate?: number;
    sleepScores?: {
      overall?: { value?: number; qualifierKey?: string };
      deepPercentage?: { value?: number };
      remPercentage?: { value?: number };
      lightPercentage?: { value?: number };
    };
  };
  restingHeartRate?: number;
  bodyBatteryChange?: number;
}

interface RawDailySummary {
  totalSteps?: number;
  dailyStepGoal?: number;
  totalDistanceMeters?: number;
  totalKilocalories?: number;
  activeKilocalories?: number;
  bmrKilocalories?: number;
  moderateIntensityMinutes?: number;
  vigorousIntensityMinutes?: number;
  intensityMinutesGoal?: number;
  minHeartRate?: number;
  restingHeartRate?: number;
  maxHeartRate?: number;
  averageStressLevel?: number;
  maxStressLevel?: number;
  bodyBatteryChargedValue?: number;
  bodyBatteryDrainedValue?: number;
  averageSpo2?: number;
  lowestSpo2?: number;
}

interface RawHrvResponse {
  hrvSummary?: {
    weeklyAvg?: number;
    lastNightAvg?: number;
    lastNight5MinHigh?: number;
    status?: string;
    baseline?: { balancedLow?: number; balancedUpper?: number };
  };
}

interface RawTrainingReadinessEntry {
  calendarDate?: string;
  score?: number;
  level?: string;
  feedbackShort?: string;
  feedbackLong?: string;
  /** 建议恢复时间（单位：分钟） */
  recoveryTime?: number;
  sleepScore?: number;
  acuteLoad?: number;
  hrvWeeklyAverage?: number;
  acwrFactorPercent?: number;
  stressHistoryFactorPercent?: number;
  sleepHistoryFactorPercent?: number;
  hrvFactorPercent?: number;
}

interface RawTrainingStatusResponse {
  mostRecentVO2Max?: { generic?: { vo2MaxValue?: number; vo2MaxPreciseValue?: number } };
  mostRecentTrainingStatus?: {
    latestTrainingStatusData?: Record<
      string,
      {
        trainingStatusFeedbackPhrase?: string;
        acuteTrainingLoadDTO?: {
          acwrStatus?: string;
          dailyTrainingLoadAcute?: number;
          dailyTrainingLoadChronic?: number;
          dailyAcuteChronicWorkloadRatio?: number;
        };
      }
    >;
    recordedDevices?: { deviceName?: string }[];
  };
  mostRecentTrainingLoadBalance?: {
    metricsTrainingLoadBalanceDTOMap?: Record<
      string,
      { trainingBalanceFeedbackPhrase?: string }
    >;
  };
}

function firstValue<T>(map: Record<string, T> | undefined): T | undefined {
  if (!map) return undefined;
  const key = Object.keys(map)[0];
  return key === undefined ? undefined : map[key];
}

export class GarminApi {
  constructor(private readonly auth: GarminAuth) {}

  /** 睡眠报告 */
  async getSleep(date: string): Promise<SleepData> {
    const raw = await this.auth.request<RawSleepResponse>(ENDPOINTS.sleepData(date));
    const dto = raw.dailySleepDTO ?? {};
    const scores = dto.sleepScores ?? {};

    return {
      date,
      overallScore: scores.overall?.value ?? null,
      overallQualifier: scores.overall?.qualifierKey ?? null,
      sleepTimeSeconds: dto.sleepTimeSeconds ?? 0,
      deepSleepSeconds: dto.deepSleepSeconds ?? 0,
      lightSleepSeconds: dto.lightSleepSeconds ?? 0,
      remSleepSeconds: dto.remSleepSeconds ?? 0,
      awakeSleepSeconds: dto.awakeSleepSeconds ?? 0,
      sleepStartLocal: formatClock(dto.sleepStartTimestampLocal),
      sleepEndLocal: formatClock(dto.sleepEndTimestampLocal),
      averageSpO2Value: dto.averageSpO2Value ?? null,
      lowestSpO2Value: dto.lowestSpO2Value ?? null,
      averageRespirationValue: dto.averageRespirationValue ?? null,
      avgSleepStress: dto.avgSleepStress ?? null,
      restingHeartRate: raw.restingHeartRate ?? dto.restingHeartRate ?? null,
      bodyBatteryChange: raw.bodyBatteryChange ?? null,
      deepPercentage: scores.deepPercentage?.value ?? null,
      remPercentage: scores.remPercentage?.value ?? null,
      lightPercentage: scores.lightPercentage?.value ?? null,
    };
  }

  /** 每日健康总览 */
  async getDailySummary(date: string): Promise<DailySummary> {
    const displayName = this.auth.getDisplayName();
    const raw = await this.auth.request<RawDailySummary>(ENDPOINTS.dailySummary(displayName, date));

    return {
      date,
      steps: raw.totalSteps ?? null,
      stepGoal: raw.dailyStepGoal ?? null,
      totalDistanceMeters: raw.totalDistanceMeters ?? null,
      totalKilocalories: raw.totalKilocalories ?? null,
      activeKilocalories: raw.activeKilocalories ?? null,
      bmrKilocalories: raw.bmrKilocalories ?? null,
      moderateIntensityMinutes: raw.moderateIntensityMinutes ?? null,
      vigorousIntensityMinutes: raw.vigorousIntensityMinutes ?? null,
      intensityMinutesGoal: raw.intensityMinutesGoal ?? null,
      minHeartRate: raw.minHeartRate ?? null,
      restingHeartRate: raw.restingHeartRate ?? null,
      maxHeartRate: raw.maxHeartRate ?? null,
      averageStressLevel: raw.averageStressLevel ?? null,
      maxStressLevel: raw.maxStressLevel ?? null,
      bodyBatteryChargedValue: raw.bodyBatteryChargedValue ?? null,
      bodyBatteryDrainedValue: raw.bodyBatteryDrainedValue ?? null,
      averageSpo2: raw.averageSpo2 ?? null,
      lowestSpo2: raw.lowestSpo2 ?? null,
    };
  }

  /** 夜间 HRV */
  async getHealthMetrics(date: string): Promise<HealthMetrics> {
    const raw = await this.auth.request<RawHrvResponse>(ENDPOINTS.hrv(date));
    const summary = raw.hrvSummary ?? {};

    return {
      date,
      hrvStatus: summary.status ?? null,
      hrvLastNightAvg: summary.lastNightAvg ?? null,
      hrvWeeklyAvg: summary.weeklyAvg ?? null,
      hrv5MinHigh: summary.lastNight5MinHigh ?? null,
      hrvBaselineLow: summary.baseline?.balancedLow ?? null,
      hrvBaselineUpper: summary.baseline?.balancedUpper ?? null,
    };
  }

  /** 训练准备度 */
  async getTrainingReadiness(date: string): Promise<TrainingReadiness> {
    const raw = await this.auth.request<RawTrainingReadinessEntry[] | RawTrainingReadinessEntry>(
      ENDPOINTS.trainingReadiness(date),
    );
    const list = Array.isArray(raw) ? raw : [raw];
    const entry = list.find((item) => item.calendarDate === date) ?? list[0] ?? {};

    return {
      date,
      score: entry.score ?? null,
      level: entry.level ?? null,
      feedbackShort: entry.feedbackShort ?? null,
      feedbackLong: entry.feedbackLong ?? null,
      recoveryTimeMinutes: entry.recoveryTime ?? null,
      sleepScore: entry.sleepScore ?? null,
      acuteLoad: entry.acuteLoad ?? null,
      hrvWeeklyAverage: entry.hrvWeeklyAverage ?? null,
      acwrFactorPercent: entry.acwrFactorPercent ?? null,
      stressHistoryFactorPercent: entry.stressHistoryFactorPercent ?? null,
      sleepHistoryFactorPercent: entry.sleepHistoryFactorPercent ?? null,
      hrvFactorPercent: entry.hrvFactorPercent ?? null,
    };
  }

  /** 训练状态（VO2max / 训练负荷 / ACWR） */
  async getTrainingStatus(date: string): Promise<TrainingStatus> {
    const raw = await this.auth.request<RawTrainingStatusResponse>(ENDPOINTS.trainingStatus(date));
    const status = firstValue(raw.mostRecentTrainingStatus?.latestTrainingStatusData);
    const load = status?.acuteTrainingLoadDTO ?? {};
    const balance = firstValue(
      raw.mostRecentTrainingLoadBalance?.metricsTrainingLoadBalanceDTOMap,
    );
    const generic = raw.mostRecentVO2Max?.generic;

    return {
      date,
      vo2Max: generic?.vo2MaxValue ?? generic?.vo2MaxPreciseValue ?? null,
      trainingStatusPhrase: status?.trainingStatusFeedbackPhrase ?? null,
      acuteLoad: load.dailyTrainingLoadAcute ?? null,
      chronicLoad: load.dailyTrainingLoadChronic ?? null,
      acwr: load.dailyAcuteChronicWorkloadRatio ?? null,
      acwrStatus: load.acwrStatus ?? null,
      balancePhrase: balance?.trainingBalanceFeedbackPhrase ?? null,
      deviceName: raw.mostRecentTrainingStatus?.recordedDevices?.[0]?.deviceName ?? null,
    };
  }
}
