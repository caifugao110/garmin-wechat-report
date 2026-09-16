/**
 * 体重/体成分数据模块
 *
 * 数据来源：iPhone 将 Apple 健康中的体重数据（华为体脂秤同步而来）通过
 * POST /webhook/weight 推送，存入 KV，供日报生成时读取展示。
 *
 * 兼容两种推送格式：
 * 1. 扁平自定义 JSON（iOS 快捷指令）：
 *    {"weight": 72.5, "bodyFatRate": 20.1, "bmi": 23.1, "muscleMass": 55.2,
 *     "measuredAt": "2026-09-16T07:00:00+08:00"}
 * 2. Health Auto Export REST API JSON：
 *    {"data":{"metrics":[{"name":"body_mass","units":"kg",
 *      "data":[{"date":"2026-09-16 07:00:00 +0800","qty":72.5}]}]}}
 */

import { formatDate } from '../utils/time.js';

/** 单次体重测量记录 */
export interface WeightMeasurement {
  /** 测量时刻对应的本地日期（YYYY-MM-DD，Asia/Shanghai），同时作为 KV key 的一部分 */
  date: string;
  /** 测量时刻（epoch 毫秒），用于同一日期内取最新 */
  measuredAtEpochMs: number;
  /** 体重（kg） */
  weightKg: number;
  /** 体脂率（%） */
  bodyFatRate?: number;
  /** BMI */
  bmi?: number;
  /** 肌肉量（kg） */
  muscleMassKg?: number;
  /** 数据来源标识（shortcuts / health-auto-export 等） */
  source?: string;
}

/** 最小 KV 接口（与 Cloudflare KVNamespace 结构兼容，便于 Node 侧类型检查） */
export interface HealthKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** KV key 前缀 */
const KEY_PREFIX = 'weight:';

function weightKey(date: string): string {
  return `${KEY_PREFIX}${date}`;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 体重合理范围（kg），超出视为无效数据 */
const MIN_WEIGHT_KG = 10;
const MAX_WEIGHT_KG = 500;

/**
 * 解析 "yyyy-MM-dd HH:mm:ss Z"（Health Auto Export 格式）为 epoch 毫秒。
 * 直接 new Date() 对该格式解析结果依赖引擎实现，这里规范化为 ISO 格式后解析。
 */
function parseHaeDate(s: string): number {
  const m = s
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(:\d{2})?)\s*([+-]\d{2}):?(\d{2})?$/);
  if (!m) throw new Error(`无法解析时间：${s}`);
  const ms = new Date(`${m[1]}T${m[2]}${m[4]}:${m[5] ?? '00'}`).getTime();
  if (Number.isNaN(ms)) throw new Error(`无法解析时间：${s}`);
  return ms;
}

/** HAE 指标名 → 测量字段 */
const HAE_METRIC_MAP: Record<string, 'weightKg' | 'bodyFatRate' | 'bmi' | 'muscleMassKg'> = {
  body_mass: 'weightKg',
  body_fat_percentage: 'bodyFatRate',
  body_mass_index: 'bmi',
  lean_body_mass: 'muscleMassKg',
};

/** 解析 Health Auto Export 格式，返回 null 表示不是该格式 */
function parseHaePayload(
  body: Record<string, unknown>,
  fallbackNowMs: number,
): WeightMeasurement | null {
  const metrics = (body.data as Record<string, unknown> | undefined)?.metrics;
  if (!Array.isArray(metrics)) return null;

  const fields: Partial<WeightMeasurement> = {};
  let latestMs = 0;
  let sawKnownMetric = false;

  for (const metric of metrics) {
    if (typeof metric !== 'object' || metric === null) continue;
    const m = metric as Record<string, unknown>;
    const field = HAE_METRIC_MAP[String(m.name)];
    if (!field || !Array.isArray(m.data) || m.data.length === 0) continue;
    sawKnownMetric = true;

    // 取该指标时间最新的一条
    let bestQty: number | null = null;
    let bestMs = -1;
    for (const entry of m.data) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (!isFiniteNumber(e.qty)) continue;
      const ms = typeof e.date === 'string' ? parseHaeDate(e.date) : fallbackNowMs;
      if (ms > bestMs) {
        bestMs = ms;
        bestQty = e.qty;
      }
    }
    if (bestQty === null) continue;
    fields[field] = bestQty;
    latestMs = Math.max(latestMs, bestMs);
  }

  if (!sawKnownMetric || !isFiniteNumber(fields.weightKg)) return null;

  const measuredAtEpochMs = latestMs > 0 ? latestMs : fallbackNowMs;
  return finalizeMeasurement(fields as Omit<WeightMeasurement, 'date' | 'measuredAtEpochMs'>, measuredAtEpochMs, 'health-auto-export');
}

/** 校验并补全日期字段 */
function finalizeMeasurement(
  fields: Omit<WeightMeasurement, 'date' | 'measuredAtEpochMs'>,
  measuredAtEpochMs: number,
  source?: string,
): WeightMeasurement {
  const { weightKg } = fields;
  if (!isFiniteNumber(weightKg) || weightKg < MIN_WEIGHT_KG || weightKg > MAX_WEIGHT_KG) {
    throw new Error(`体重必须在 ${MIN_WEIGHT_KG}-${MAX_WEIGHT_KG} kg 之间`);
  }
  const measurement: WeightMeasurement = {
    date: formatDate(new Date(measuredAtEpochMs)),
    measuredAtEpochMs,
    weightKg,
    source,
  };
  if (isFiniteNumber(fields.bodyFatRate)) measurement.bodyFatRate = fields.bodyFatRate;
  if (isFiniteNumber(fields.bmi)) measurement.bmi = fields.bmi;
  if (isFiniteNumber(fields.muscleMassKg)) measurement.muscleMassKg = fields.muscleMassKg;
  return measurement;
}

/**
 * 解析 webhook 推送的体重数据（自动识别扁平 / Health Auto Export 两种格式）。
 * 体重必填且在合理范围内，否则抛错。
 */
export function parseWeightPayload(body: unknown, fallbackNowMs: number): WeightMeasurement {
  if (typeof body !== 'object' || body === null) {
    throw new Error('请求体必须是 JSON 对象');
  }
  const obj = body as Record<string, unknown>;

  // Health Auto Export 格式
  const hae = parseHaePayload(obj, fallbackNowMs);
  if (hae) return hae;

  // 扁平自定义格式
  if (!isFiniteNumber(obj.weight)) {
    throw new Error('缺少有效的 weight 字段（kg）');
  }
  const measuredAtEpochMs =
    typeof obj.measuredAt === 'string' && !Number.isNaN(new Date(obj.measuredAt).getTime())
      ? new Date(obj.measuredAt).getTime()
      : fallbackNowMs;
  const fields: Partial<WeightMeasurement> = {
    weightKg: obj.weight,
    bodyFatRate: isFiniteNumber(obj.bodyFatRate) ? obj.bodyFatRate : undefined,
    bmi: isFiniteNumber(obj.bmi) ? obj.bmi : undefined,
    muscleMassKg: isFiniteNumber(obj.muscleMass) ? obj.muscleMass : undefined,
  };
  return finalizeMeasurement(
    fields as Omit<WeightMeasurement, 'date' | 'measuredAtEpochMs'>,
    measuredAtEpochMs,
    typeof obj.source === 'string' ? obj.source : 'shortcuts',
  );
}

/**
 * 保存测量记录到 KV（按日 key，仅当新测量时间更新时覆盖）。
 * @returns 是否实际写入
 */
export async function saveWeightMeasurement(kv: HealthKV, m: WeightMeasurement): Promise<boolean> {
  const key = weightKey(m.date);
  try {
    const existing = await kv.get(key);
    if (existing) {
      const prev = JSON.parse(existing) as WeightMeasurement;
      if (isFiniteNumber(prev?.measuredAtEpochMs) && prev.measuredAtEpochMs >= m.measuredAtEpochMs) {
        return false;
      }
    }
  } catch {
    // 已有记录损坏时直接覆盖
  }
  await kv.put(key, JSON.stringify(m));
  return true;
}

/** 读取指定日期的测量记录，异常或无数据返回 null */
export async function getWeight(kv: HealthKV, date: string): Promise<WeightMeasurement | null> {
  try {
    const raw = await kv.get(weightKey(date));
    if (!raw) return null;
    const m = JSON.parse(raw) as WeightMeasurement;
    if (!isFiniteNumber(m?.weightKg)) return null;
    return m;
  } catch {
    return null;
  }
}

/** 在多个日期的记录中取测量时间最新的一条 */
export async function getLatestWeight(
  kv: HealthKV,
  dates: string[],
): Promise<WeightMeasurement | null> {
  const all = (await Promise.all(dates.map((d) => getWeight(kv, d)))).filter(
    (m): m is WeightMeasurement => m !== null,
  );
  if (all.length === 0) return null;
  return all.reduce((a, b) => (b.measuredAtEpochMs > a.measuredAtEpochMs ? b : a));
}
