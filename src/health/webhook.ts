/**
 * 体重数据 webhook：接收 iPhone 快捷指令 / Health Auto Export 推送的体重数据
 *
 * 鉴权：Authorization: Bearer <WEIGHT_WEBHOOK_SECRET>
 * 依赖：KV 绑定 HEALTH_KV + secret WEIGHT_WEBHOOK_SECRET
 */

import { parseWeightPayload, saveWeightMeasurement, type HealthKV } from './weight.js';

interface WeightWebhookEnv {
  HEALTH_KV?: HealthKV;
  WEIGHT_WEBHOOK_SECRET?: string;
}

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function handleWeightWebhook(
  request: Request,
  env: WeightWebhookEnv,
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ status: 'error', message: '仅支持 POST 请求' }, 405);
  }
  if (!env.HEALTH_KV) {
    return jsonResponse({ status: 'error', message: '未配置 KV：请在 wrangler.toml 绑定 HEALTH_KV' }, 503);
  }
  if (!env.WEIGHT_WEBHOOK_SECRET) {
    return jsonResponse({ status: 'error', message: '未配置 WEIGHT_WEBHOOK_SECRET' }, 503);
  }

  const auth = request.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${env.WEIGHT_WEBHOOK_SECRET}`) {
    return jsonResponse({ status: 'error', message: '鉴权失败' }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ status: 'error', message: '请求体不是有效 JSON' }, 400);
  }

  let measurement;
  try {
    measurement = parseWeightPayload(body, Date.now());
  } catch (err) {
    return jsonResponse(
      { status: 'error', message: `数据无效：${err instanceof Error ? err.message : String(err)}` },
      400,
    );
  }

  const saved = await saveWeightMeasurement(env.HEALTH_KV, measurement);
  return jsonResponse(
    {
      status: 'ok',
      date: measurement.date,
      weightKg: measurement.weightKg,
      saved,
    },
    200,
  );
}
