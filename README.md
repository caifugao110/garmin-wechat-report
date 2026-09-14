# Garmin Daily Report

每日自动汇总 Garmin Connect 健康数据，生成 Markdown 日报，并通过 [Server酱](https://sct.ftqq.com) 推送到微信。

纯 HTTP 实现 Garmin 认证链（OAuth1 → OAuth2），仅依赖 `fetch` 与 Web Crypto，无浏览器、无第三方 Garmin SDK 依赖。

## 功能特性

- 睡眠报告：评分、深睡 / 浅睡 / REM / 清醒时长与占比、血氧、呼吸率
- 每日总览：步数、卡路里、强度分钟、心率、压力、身体电量
- 夜间生理指标：HRV、基线区间、近 7 天平均
- 训练负荷与恢复：训练准备度、建议恢复时间、训练状态、VO2max、急慢性负荷比
- 与 7 天前数据的周度趋势对比
- Server酱 推送到微信；失败时自动推送异常通知
- 三种运行方式：本地命令行、GitHub Actions 定时任务、Cloudflare Workers Cron

## 环境要求

- Node.js >= 20（推荐 24）
- Garmin Connect 账号
- Server酱 SendKey（在 https://sct.ftqq.com 免费申请）

## 配置项

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `GARMIN_USERNAME` | 二选一 | Garmin 账号（邮箱） |
| `GARMIN_PASSWORD` | 二选一 | Garmin 密码 |
| `GARMIN_OAUTH1_TOKEN` | 二选一 | 长效 OAuth1 token，`npm run token` 生成，CI 推荐 |
| `GARMIN_OAUTH1_TOKEN_SECRET` | 配合 token | OAuth1 token secret |
| `SERVERCHAN_SENDKEY` | 否 | Server酱 SendKey，不配置则只生成报告不推送 |
| `DRY_RUN` | 否 | 设为 `1` 时只生成不推送，本地调试用 |

## 本地运行

```bash
# 1. 安装依赖
npm ci

# 2. 准备配置
cp .env.example .env
# 编辑 .env，填入 GARMIN_USERNAME / GARMIN_PASSWORD / SERVERCHAN_SENDKEY

# 3. 运行（调试时可先在 .env 中设置 DRY_RUN=1）
npm start
```

## GitHub Actions 部署（推荐）

1. 将代码推送到 GitHub 仓库。
2. 打开仓库 **Settings → Secrets and variables → Actions → New repository secret**，添加：
   - `SERVERCHAN_SENDKEY`：Server酱 SendKey
   - `GARMIN_USERNAME`、`GARMIN_PASSWORD`：Garmin 账号密码
3. 打开 **Actions** 页面，选择 **Garmin Daily Report → Run workflow** 手动验证一次。
4. 验证通过后即自动定时运行：每天北京时间 07:30（UTC 23:30）。

### 重要：GitHub Actions 登录被 Garmin 风控怎么办？

`sso.garmin.com` 前置 Cloudflare，经常拦截 GitHub Actions 等云机房 IP，报错通常是
`SSO 登录失败：未找到 _csrf token`、`403` 或 `429`。本项目提供 token 直登方案绕过 SSO：

```bash
# 在本机（.env 已配置账号密码）执行，完成一次正常登录
npm run token
```

脚本会打印 `GARMIN_OAUTH1_TOKEN` 与 `GARMIN_OAUTH1_TOKEN_SECRET` 两个值，
将它们添加为仓库 Actions Secrets。之后 CI 只访问 `connectapi.garmin.com` 直接换取会话，
不再经过被风控的 SSO 站点。

注意：

- token 长期有效，等同于账号凭据，请勿提交到仓库或泄露
- 若日后 CI 再次报认证失败，重新执行 `npm run token` 更新 Secrets 即可
- workflow 内置了凭据预检步骤，配置缺失时会直接提示缺少哪个变量

## Cloudflare Workers 部署

项目同样可以作为 Worker 由 Cron Trigger 触发：

```bash
# 写入三个 secret
npx wrangler secret put GARMIN_USERNAME
npx wrangler secret put GARMIN_PASSWORD
npx wrangler secret put SERVERCHAN_SENDKEY
# 如 Actions 一样遇到 SSO 风控，可改用 GARMIN_OAUTH1_TOKEN / GARMIN_OAUTH1_TOKEN_SECRET

# 部署
npm run deploy
```

- 定时规则在 [wrangler.toml](wrangler.toml) 中配置（默认 UTC 23:30 = 北京 07:30）
- 部署后访问 `https://<your-worker>.workers.dev/run` 可手动触发
- 追加 `?date=YYYY-MM-DD` 可补跑指定日期

## 常见问题

**收到「Garmin 日报登录失败：未拿到 ticket」？**
账号密码错误、开启了两步验证，或登录 IP 被风控。本地浏览器登录一次确认账号状态；
CI 环境改用上文的 OAuth1 token 方案。

**收到 HTTP 429？**
短时间内登录过于频繁被限流，等待一段时间后再触发，避免反复手动运行。

**收不到微信推送？**
检查 `SERVERCHAN_SENDKEY` 是否正确、SendKey 是否过期；本地可设 `DRY_RUN=1` 先确认报告生成正常。

## 免责声明

本项目为非官方个人工具，与 Garmin 无关。Garmin 接口如有变动可能导致不可用，使用风险自负。

## License

[MIT](LICENSE) © Tobin
