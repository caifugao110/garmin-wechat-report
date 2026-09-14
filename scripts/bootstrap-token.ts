/**
 * 一次性引导脚本：在本机用账号密码完成 SSO 登录，导出长效 OAuth1 token。
 *
 * 背景：sso.garmin.com 前置 Cloudflare，会拦截 GitHub Actions 等云机房 IP
 * （报错“未找到 _csrf token”或 403/429）。OAuth1 token 只需在本机获取一次，
 * 配置到 CI 后，运行时只访问 connectapi.garmin.com 直接换取会话，不再经过 SSO。
 *
 * 用法：
 *   1. 在 .env 中配好 GARMIN_USERNAME / GARMIN_PASSWORD
 *   2. 执行 npm run token
 *   3. 将打印的两个值分别配置为 GitHub Actions Secrets：
 *        GARMIN_OAUTH1_TOKEN
 *        GARMIN_OAUTH1_TOKEN_SECRET
 *
 * token 长期有效；若 CI 再次报认证失败，重新执行本脚本更新即可。
 */

import 'dotenv/config';
import { GarminAuth } from '../src/garmin/auth.js';

async function main(): Promise<void> {
  const username = process.env.GARMIN_USERNAME;
  const password = process.env.GARMIN_PASSWORD;

  if (!username || !password) {
    throw new Error('缺少 GARMIN_USERNAME / GARMIN_PASSWORD，请先在 .env 中配置');
  }

  const auth = new GarminAuth((msg) => console.log(msg));
  await auth.login(username, password);
  await auth.getProfile();
  const token = auth.getOAuth1Token();

  console.log('');
  console.log('登录成功。请将以下两个值配置到 GitHub 仓库');
  console.log('Settings → Secrets and variables → Actions → New repository secret：');
  console.log('');
  console.log(`GARMIN_OAUTH1_TOKEN        = ${token.key}`);
  console.log(`GARMIN_OAUTH1_TOKEN_SECRET = ${token.secret ?? ''}`);
  console.log('');
  console.log('注意：这两个值等同于账号凭据，请勿提交到仓库或分享给他人。');
}

main().catch((err) => {
  console.error('[bootstrap] 生成 token 失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
