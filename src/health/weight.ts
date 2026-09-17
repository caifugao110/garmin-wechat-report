/**
 * 体重/体成分数据模块
 *
 * 数据来源：iPhone 将 Apple 健康中的体重数据（华为体脂秤同步而来）通过
 * POST SCF /webhook/weight 推送，SCF 存入腾讯云 COS，Worker 日报生成时从 COS 读取展示。
 *
 * 存储：腾讯云 COS，bucket 公有读私有写
 *   - 对象 key：weight/{YYYY-MM-DD}.json
 *   - 内容：WeightMeasurement JSON
 *
 * Worker 端读取走公有读（直接 fetch），无需签名；
 * SCF 端写入走 TC3-HMAC-SHA256 签名（见 cos-writer.ts）。
 */

/** 单次体重测量记录 */
export interface WeightMeasurement {
  /** 测量时刻对应的本地日期（YYYY-MM-DD，Asia/Shanghai），同时作为 COS 对象 key 的一部分 */
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

/** 体重合理范围（kg），超出视为无效数据 */
const MIN_WEIGHT_KG = 10;
const MAX_WEIGHT_KG = 500;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 把未知值安全转成 number，接受 number 或可解析的数字字符串（iOS 快捷指令常把
 * JSON 里的数值序列化成字符串，例如 "72.5"）。解析失败返回 null。
 */
function toNumber(v: unknown): number | null {
  if (isFiniteNumber(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * 解析 "yyyy-MM-dd HH:mm:ss Z"（Health Auto Export 格式）为 epoch 毫秒。
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

    let bestQty: number | null = null;
    let bestMs = -1;
    for (const entry of m.data) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const qty = toNumber(e.qty);
      if (qty === null) continue;
      const ms = typeof e.date === 'string' ? parseHaeDate(e.date) : fallbackNowMs;
      if (ms > bestMs) {
        bestMs = ms;
        bestQty = qty;
      }
    }
    if (bestQty === null) continue;
    fields[field] = bestQty;
    latestMs = Math.max(latestMs, bestMs);
  }

  if (!sawKnownMetric || !isFiniteNumber(fields.weightKg)) return null;

  const measuredAtEpochMs = latestMs > 0 ? latestMs : fallbackNowMs;
  return finalizeMeasurement(
    fields as Omit<WeightMeasurement, 'date' | 'measuredAtEpochMs'>,
    measuredAtEpochMs,
    'health-auto-export',
  );
}

/** 校验并补全日期字段 */
function finalizeMeasurement(
  fields: Omit<WeightMeasurement, 'date' | 'measuredAtEpochMs'>,
  measuredAtEpochMs: number,
  source?: string,
): WeightMeasurement {
  const { weightKg } = fields;
  if (
    !isFiniteNumber(weightKg) ||
    weightKg < MIN_WEIGHT_KG ||
    weightKg > MAX_WEIGHT_KG
  ) {
    throw new Error(`体重必须在 ${MIN_WEIGHT_KG}-${MAX_WEIGHT_KG} kg 之间`);
  }
  const measurement: WeightMeasurement = {
    date: formatDate(new Date(measuredAtEpochMs)),
    measuredAtEpochMs,
    weightKg,
    source,
  };
  if (toNumber(fields.bodyFatRate) !== null) measurement.bodyFatRate = toNumber(fields.bodyFatRate)!;
  if (toNumber(fields.bmi) !== null) measurement.bmi = toNumber(fields.bmi)!;
  if (toNumber(fields.muscleMassKg) !== null) measurement.muscleMassKg = toNumber(fields.muscleMassKg)!;
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

  const hae = parseHaePayload(obj, fallbackNowMs);
  if (hae) return hae;

  const weightVal = toNumber(obj.weight);
  if (weightVal === null) {
    throw new Error('缺少有效的 weight 字段（kg）');
  }
  const measuredAtEpochMs =
    typeof obj.measuredAt === 'string' && !Number.isNaN(new Date(obj.measuredAt).getTime())
      ? new Date(obj.measuredAt).getTime()
      : fallbackNowMs;
  const fields: Partial<WeightMeasurement> = {
    weightKg: weightVal,
    bodyFatRate: toNumber(obj.bodyFatRate) ?? undefined,
    bmi: toNumber(obj.bmi) ?? undefined,
    muscleMassKg: toNumber(obj.muscleMass) ?? undefined,
  };
  return finalizeMeasurement(
    fields as Omit<WeightMeasurement, 'date' | 'measuredAtEpochMs'>,
    measuredAtEpochMs,
    typeof obj.source === 'string' ? obj.source : 'shortcuts',
  );
}

/** 把 Date 格式化为指定时区的 YYYY-MM-DD 字符串（避免循环依赖 utils/time.ts） */
function formatDate(date: Date, tz = 'Asia/Shanghai'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** 读取指定日期的测量记录（Worker 端：COS 公有读，直接 fetch），异常或无数据返回 null */
export async function getWeightFromCos(
  cosBaseUrl: string,
  date: string,
): Promise<WeightMeasurement | null> {
  const url = `${cosBaseUrl.replace(/\/$/, '')}/weight/${date}.json`;
  try {
    const resp = await fetch(url);
    if (resp.status === 404 || !resp.ok) return null;
    const m = (await resp.json()) as WeightMeasurement;
    if (!isFiniteNumber(m?.weightKg)) return null;
    return m;
  } catch {
    return null;
  }
}

/** 在多个日期的记录中取测量时间最新的一条 */
export async function getLatestWeightFromCos(
  cosBaseUrl: string,
  dates: string[],
): Promise<WeightMeasurement | null> {
  const all = (await Promise.all(dates.map((d) => getWeightFromCos(cosBaseUrl, d)))).filter(
    (m): m is WeightMeasurement => m !== null,
  );
  if (all.length === 0) return null;
  return all.reduce((a, b) => (b.measuredAtEpochMs > a.measuredAtEpochMs ? b : a));
}
