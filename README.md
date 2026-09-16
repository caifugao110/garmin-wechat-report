# Garmin Daily Report

[English](README.en.md) | 简体中文

每日自动汇总 Garmin Connect 健康数据，生成 Markdown 日报，并通过 [Server酱](https://sct.ftqq.com) 推送到微信。同时内置**企业微信自建应用对话式 AI 助手**，在企业微信 App 内直接与 AI 对话查询 Garmin 数据。

纯 HTTP 实现 Garmin 认证链（OAuth1 → OAuth2），仅依赖 `fetch` 与 Web Crypto，无浏览器、无第三方 Garmin SDK 依赖。

## 功能特性

- 睡眠报告：评分、深睡 / 浅睡 / REM / 清醒时长与占比、血氧、呼吸率
- 每日总览：步数、卡路里、强度分钟、心率、压力、身体电量
- 夜间生理指标：HRV、基线区间、近 7 天平均
- 训练负荷与恢复：训练准备度、建议恢复时间、训练状态、VO2max、急慢性负荷比
- 与 7 天前数据的周度趋势对比
- **体重与体成分（可选）**：iPhone 把 Apple 健康中的体重 / 体脂率 / BMI / 肌肉量推送到 Worker webhook，日报自动展示，支持 7 天趋势对比（适用于华为体脂秤等经华为运动健康同步到 Apple 健康的数据）
- **内置规则引擎**：离线根据阈值自动生成「今日建议」，重要告警优先展示，无需任何外部服务
- **AI 健康分析（可选，已内置）**：配置 DeepSeek 等任意 OpenAI 兼容服务的 API Key 后，报告末尾自动追加一段个性化大模型建议；AI 接口失败只记日志，不影响正常推送
- Server酱 / 企业微信群机器人推送到微信；失败时自动推送异常通知
- **企业微信对话式 AI 助手**（可选）：在企业微信 App 内与自建应用直接对话，AI 会调用 Garmin API 回答步数、睡眠、HRV 等问题，底层用被动回复架构绕开 IP 白名单限制
- 四种运行方式：本地命令行、GitHub Actions 定时任务、Cloudflare Workers Cron、**腾讯云函数 SCF（企业微信对话）**
- 报告结构模块化，方便改造内容或更换推送渠道（见下文指南）

## 工作原理

### 定时日报路径（本地 / Actions / Worker）

```
src/index.ts（Node 入口）   ┐
                            ├─→ src/pipeline.ts（核心编排）
src/worker.ts（Worker 入口）┘            │
                                         ├─ 1. garmin/auth.ts   完成 OAuth1 → OAuth2 认证
                                         ├─ 2. garmin/api.ts    并发拉取睡眠 / 总览 / HRV / 训练数据
                                         ├─ 3. report/formatter.ts 生成 Markdown
                                         │      └─ report/advice.ts 规则引擎生成「今日建议」
                                         ├─ 4. ai/advice.ts       （可选）调用大模型追加「AI 健康建议」
                                         └─ 5. notify/            Server酱 / 企业微信推送
```

### 企业微信对话路径（腾讯云函数 SCF）

```
企业微信服务器 POST /wecom/callback
         │
         ▼
src/scf/handler.ts ──→ src/wecom/callback.ts ──→ src/wecom/crypto.ts（验签 + 解密）
         │
         ▼
src/wecom/chat.ts（LLM 主循环，tool_call 调度）
         │
         ├── src/garmin/auth.ts + api.ts ── 实时查询 Garmin 数据
         └── src/wecom/crypto.ts ── 加密被动回复 XML → 直接在 POST 响应体返回
```

对话路径采用**被动回复架构**：不调企业微信主动消息 API（send，需出口 IP 白名单），而是在 POST 回调响应里直接返回加密的回复 XML。零出站调用，完全绕开 `errcode=60020` IP 白名单限制。详见下文「架构说明：被动回复 vs 主动推送」。

## 环境要求

- Node.js >= 20（推荐 24）
- Garmin Connect 账号
- Server酱 SendKey（在 https://sct.ftqq.com 免费申请）

## 配置项

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `GARMIN_USERNAME` | 二选一 | Garmin 账号（邮箱） |
| `GARMIN_PASSWORD` | 二选一 | Garmin 密码 |
| `GARMIN_OAUTH1_TOKEN` | 二选一 | 长效 OAuth1 token，`npm run token` 生成，CI / 对话路径推荐 |
| `GARMIN_OAUTH1_TOKEN_SECRET` | 配合 token | OAuth1 token secret |
| `SERVERCHAN_SENDKEY` | 否 | Server酱 SendKey，不配置则只生成报告不推送 |
| `WECOM_BOT_KEY` | 否 | 企业微信群机器人 Webhook key，配置后额外推送一份到企业微信群 |
| `AI_API_KEY` | 否 | 开启 AI 健康分析的 API Key（DeepSeek 等 OpenAI 兼容服务）；企业微信对话也需要 |
| `AI_BASE_URL` | 否 | OpenAI 兼容接口地址，默认 `https://api.deepseek.com` |
| `AI_MODEL` | 否 | 模型名，默认 `deepseek-chat` |
| `DRY_RUN` | 否 | 设为 `1` 时只生成不推送，本地调试用 |
| `WECOM_CORP_ID` | 对话必需 | 企业 ID，企业微信管理后台「我的企业 → 企业信息」 |
| `WECOM_CORP_SECRET` | 对话必需 | 自建应用 Secret，应用详情页获取 |
| `WECOM_AGENT_ID` | 对话必需 | 自建应用 AgentId |
| `WECOM_TOKEN` | 对话必需 | 接收消息 API 的自定义 Token |
| `WECOM_ENCODING_AES_KEY` | 对话必需 | 接收消息 API 的 EncodingAESKey（43 字符） |

本地运行时变量从 `.env` 读取；GitHub Actions 从 **Repository secrets** 注入；Cloudflare Workers 从 **Wrangler secrets** 注入。三种方式的变量名完全相同。

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

报告 Markdown 会直接打印在终端，可先确认内容再配置推送。

## GitHub Actions 部署（推荐）

### 第 1 步：Fork 仓库

1. 打开上游仓库 [github.com/caifugao110/garmin-wechat-report](https://github.com/caifugao110/garmin-wechat-report)，点击右上角 **Fork**，把代码复制到你自己的 GitHub 账号下。
2. 进入 Fork 后的仓库，打开 **Actions** 标签页。Fork 出来的仓库默认关闭 Actions，页面会提示 *Workflows aren't being run on this forked repository*，点击 **I understand my workflows, go ahead and enable them** 启用。

### 第 2 步：配置 Repository secrets

在你的 Fork 仓库中打开：

**Settings → Secrets and variables → Actions → （页面下方）Repository secrets → New repository secret**

逐个添加以下 secret（名称必须完全一致，区分大小写）：

| Secret 名称 | 是否必填 | 填什么 |
| --- | --- | --- |
| `GARMIN_USERNAME` | 二选一 | Garmin 登录邮箱 |
| `GARMIN_PASSWORD` | 二选一 | Garmin 登录密码 |
| `GARMIN_OAUTH1_TOKEN` | 二选一（推荐） | 本机执行 `npm run token` 得到的 token |
| `GARMIN_OAUTH1_TOKEN_SECRET` | 配合 token | 本机执行 `npm run token` 得到的 secret |
| `SERVERCHAN_SENDKEY` | 推荐 | Server酱 SendKey，不填则只跑任务不推送 |
| `WECOM_BOT_KEY` | 否 | 企业微信群机器人 Webhook key，配置后额外推送到企业微信群 |
| `AI_API_KEY` | 否 | 开启 AI 健康分析；不配置则报告不含 AI 建议区块 |
| `AI_BASE_URL` | 否 | 自定义 OpenAI 兼容接口地址，不配则默认 DeepSeek |
| `AI_MODEL` | 否 | 模型名，不配则默认 `deepseek-chat` |

即：**账号密码** 与 **OAuth1 token** 两组凭据二选一。推荐使用 token 方案（原因见下文风控说明）。配好后 secret 列表应类似：

```
GARMIN_OAUTH1_TOKEN
GARMIN_OAUTH1_TOKEN_SECRET
GARMIN_PASSWORD
GARMIN_USERNAME
SERVERCHAN_SENDKEY
# 以下为可选项：
WECOM_BOT_KEY
AI_API_KEY
AI_BASE_URL
AI_MODEL
```

关于 Repository secrets 的几点说明：

- Secret 保存后**只能更新、不能再查看原值**。需要更换时点右侧铅笔图标（Update secret），删除点垃圾桶图标。
- Secret 是加密存储的，只会以环境变量形式注入 workflow 运行环境，日志中也会被自动遮罩，不会出现在代码里。
- 凭据类信息必须放在 **Secrets**（加密）而不是 **Variables**（明文）。`Variables` 只适合非敏感配置。
- workflow 文件 [.github/workflows/daily-report.yml](.github/workflows/daily-report.yml) 中通过 `${{ secrets.XXX }}` 引用，且内置了凭据预检步骤：两组凭据都没配时任务会直接失败并提示缺少哪个变量。

### 第 3 步：手动触发验证一次

1. 打开 **Actions** 标签页，左侧选择 **Garmin Daily Report**。
2. 点击右侧 **Run workflow** 手动运行一次。
3. 点进本次运行记录，查看各步骤日志。成功后微信应收到日报；失败时根据日志提示排查（常见问题见文末）。

### 第 4 步：自动定时运行

验证通过后无需再做任何操作，workflow 会按 cron 定时执行：

```yaml
on:
  schedule:
    - cron: '40 23 * * *'   # 主触发：UTC 23:40 = 北京时间次日 07:40
    - cron: '50 23 * * *'   # 备用触发：UTC 23:50 = 北京时间次日 07:50
  workflow_dispatch:        # 保留手动触发
```

注意：

- 每天有两个定时触发：**北京 07:40 主触发、07:50 备用触发**。工作流启动时会通过 GitHub API 检查 12 小时内是否已有**成功**的定时运行：已有则备用触发自动跳过，不会重复推送；主触发失败、延迟或被 GitHub 跳过时，备用触发负责补发。手动触发（workflow_dispatch）不受此限制。
- GitHub Actions 的 cron 使用 **UTC 时间**，北京时间 = UTC + 8。想改推送时间就修改 [.github/workflows/daily-report.yml](.github/workflows/daily-report.yml) 中的 cron，例如 `0 0 * * *` 是北京 08:00、`0 22 * * *` 是北京 06:00。
- GitHub 的定时任务不保证准点，高峰期可能延迟几分钟到几十分钟，极端情况下会被直接丢弃——这正是配置备用触发的原因。
- 仓库连续 60 天没有任何提交活动时，GitHub 会自动暂停定时 workflow；重新到 Actions 页面启用或推送一次提交即可恢复。

### 重要：GitHub Actions 登录被 Garmin 风控怎么办？

`sso.garmin.com` 前置 Cloudflare，经常拦截 GitHub Actions 等云机房 IP，报错通常是
`SSO 登录失败：未找到 _csrf token`、`403` 或 `429`。本项目提供 token 直登方案绕过 SSO：

```bash
# 在本机（.env 已配置账号密码）执行，完成一次正常登录
npm run token
```

脚本会打印 `GARMIN_OAUTH1_TOKEN` 与 `GARMIN_OAUTH1_TOKEN_SECRET` 两个值，
将它们添加为仓库 Actions Secrets（步骤见上文）。之后 CI 只访问 `connectapi.garmin.com` 直接换取会话，
不再经过被风控的 SSO 站点。

注意：

- token 长期有效，等同于账号凭据，请勿提交到仓库或泄露
- 若日后 CI 再次报认证失败，重新执行 `npm run token` 更新 Secrets 即可
- workflow 内置了凭据预检步骤，配置缺失时会直接提示缺少哪个变量

### 如何关闭 / 暂停 GitHub Actions 部署

按需求选择一种方式（关闭后不会再产生任何 Garmin 请求，Secrets 可保留也可删除）：

1. **临时暂停，保留以后恢复（推荐）**：打开 **Actions** → 左侧选中 **Garmin Daily Report** → 右上角 `⋯` 菜单 → **Disable workflow**。恢复时点同一位置的 **Enable workflow**。
2. **只保留手动触发、取消每天定时**：编辑 [.github/workflows/daily-report.yml](.github/workflows/daily-report.yml)，删除 `on.schedule` 整块，只保留 `workflow_dispatch:`，提交推送。
3. **彻底移除**：直接删除文件 `.github/workflows/daily-report.yml` 并推送，该 workflow 即永久消失。
4. **关闭整个仓库的 Actions**：**Settings → Actions → General → Actions permissions**，选择 **Disable actions**。

## Cloudflare Workers 部署

项目同样可以作为 Worker 由 Cron Trigger 触发：

```bash
# 写入 secret（逐条执行，终端会提示输入值，不回显）
npx wrangler secret put GARMIN_USERNAME
npx wrangler secret put GARMIN_PASSWORD
npx wrangler secret put SERVERCHAN_SENDKEY
# 如 Actions 一样遇到 SSO 风控，可改用：
npx wrangler secret put GARMIN_OAUTH1_TOKEN
npx wrangler secret put GARMIN_OAUTH1_TOKEN_SECRET

# 本地模拟 Worker 调试（可选）
npm run worker:dev
# 然后访问 http://localhost:8787/run

# 部署
npm run deploy
```

- 定时规则在 [wrangler.toml](wrangler.toml) 中配置（默认 UTC 23:40 = 北京 07:40）。Cloudflare Cron 触发稳定、不会像 GitHub 那样丢调度，因此只配置一个时间点；备用补发机制仅用于 GitHub Actions
- 部署后访问 `https://garmin-daily-report.caifugao110.workers.dev/run` 可手动触发
- 追加 `?date=YYYY-MM-DD` 可补跑指定日期

### 如何关闭 / 停用 Cloudflare Workers 部署

1. **只停止每日定时、保留手动 `/run`**：编辑 [wrangler.toml](wrangler.toml)，把 `[triggers]` 下的 `crons` 清空（`crons = []` 或整段删除），然后重新执行 `npm run deploy` 生效。也可以在 Cloudflare 控制台 **Workers & Pages → 你的 Worker → Settings → Triggers（Cron Triggers）** 中直接删除定时条目。
2. **停用整个 Worker**：Cloudflare 控制台 **Workers & Pages → 你的 Worker** 详情页中选择 Disable / 停止（具体文案随控制台版本略有差异），停用后 `/run` 也不再响应。
3. **彻底删除 Worker**：控制台删除，或在项目目录执行 `npx wrangler delete`。
4. **清理凭据（可选）**：`npx wrangler secret list` 查看，`npx wrangler secret delete <名称>` 删除。

> GitHub Actions 与 Cloudflare Workers 两种部署互不冲突，可只用一种，也可同时部署。若同时启用，请确认两边的定时时间错开，避免同一账号短时间内发起两次登录触发 429。

## 体重数据接入（可选，已配置完成）

把 iPhone「Apple 健康」中的体重 / 体脂率 / BMI / 肌肉量（华为体脂秤等设备经华为运动健康 App 同步而来）推送到腾讯云函数，日报中会新增「体重与体成分」板块并在周度趋势表展示体重变化。

数据链路（`*.workers.dev` 在大陆被阻断，因此 webhook 由 SCF 承接，数据存 COS，Worker 日报时从 COS 公有读读取）：

```
体脂秤 → 华为运动健康(iOS，开启 Apple 健康同步) → Apple 健康 → iPhone 快捷指令 / Health Auto Export
      → POST https://1312201327-j7lq4qnirc.ap-shanghai.tencentscf.com/webhook/weight
      → SCF 解析 → 腾讯云 COS（garmin-weight-data-1312201327，公有读私有写）
      → Worker 日报 fetch 读取 → 报告展示
```

### 已完成的配置

- SCF 函数 `garmin-wecom-bot` 已部署，含 `/webhook/weight` 路由
- COS bucket `garmin-weight-data-1312201327`（ap-shanghai）已创建，ACL 公有读私有写
- SCF 环境变量已配置：`COS_SECRET_ID` / `COS_SECRET_KEY` / `COS_BUCKET` / `COS_REGION`
- Worker `[vars]` 已配置 `COS_WEIGHT_BASE_URL`

### 推送端配置（二选一）

**方式 A：iOS 快捷指令（免费）**

1. 快捷指令 → 自动化 → 新建「个人自动化」→ 选「特定时间」（如 07:20）
2. 添加动作「查找健康样本」（类别选体重 / 体脂率等）获取最新数据
3. 用「词典」动作构造 JSON 文本，例如：

```json
{"weight": 72.5, "bodyFatRate": 20.1, "bmi": 23.1, "muscleMass": 55.2}
```

4. 添加「获取 URL 内容」：URL 填 `https://1312201327-j7lq4qnirc.ap-shanghai.tencentscf.com/webhook/weight`，方法 POST，请求体选上一步的 JSON，Content-Type 设为 application/json

**方式 B：Health Auto Export App（需 Premium）**

1. Automations → + → REST API
2. URL 填 `https://1312201327-j7lq4qnirc.ap-shanghai.tencentscf.com/webhook/weight`，Format 选 JSON
3. Health Metrics 勾选 Body Mass / Body Fat Percentage / Body Mass Index / Lean Body Mass
4. Schedule 选 Automatic（或每天固定时间）

两种格式服务端均支持（自动识别）。手动验证：

```bash
curl -X POST https://1312201327-j7lq4qnirc.ap-shanghai.tencentscf.com/webhook/weight \
  -H "Content-Type: application/json" \
  -d '{"weight": 72.5, "bodyFatRate": 20.1}'
```

> 说明：日报每天 07:40 生成，会读取昨天 + 今天两条 COS 记录中最新的一次测量，因此晚上称或早上称都会出现在当天日报里。SCF webhook 当前无鉴权（仅暴露体重写入，数据敏感度低）；如需加鉴权可在 SCF 环境变量配置 token 后扩展。

## 腾讯云函数 SCF 部署（企业微信对话式 AI）

> 为什么选腾讯云函数？Cloudflare 的 `*.workers.dev` 免费域名在中国大陆被网络阻断，企业微信验证服务器（国内）无法连接回调地址；同时 Cloudflare Worker 出口 IP 池不可预测，无法加入企业微信「可信 IP」白名单。腾讯云函数与企业微信同属腾讯生态，国内直连、自带国内 HTTPS 地址，是对话式回调的最佳落地平台。

### 架构说明：被动回复 vs 主动推送

企业微信自建应用回复用户消息有两种方式：

| 方式 | 原理 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **主动推送** | POST 回调返回 `success`，再异步调 `POST /cgi-bin/message/send` 发消息 | 不受 5 秒超时限制 | **send API 要求调用方出口 IP 在企业可信 IP 白名单内**（`errcode=60020`）。Cloudflare Workers IP 池太大、腾讯云函数 NAT 池被标记为"第三方服务商 IP"，均无法加白 |
| **被动回复** | POST 回调内同步处理完对话，直接返回加密的回复 XML | **零出站调用，完全绕开 IP 白名单** | 必须在 5 秒内完成（本项目 LLM+Garmin 热路径 2~5 秒，实测可通过） |

本项目对话路径采用**被动回复**架构。消息加密用 AES-256-CBC + 32 字节块 PKCS7 填充（Web Crypto 自动追加的 16 字节块已手动切掉），签名用 SHA-1，全部在 [src/wecom/crypto.ts](src/wecom/crypto.ts) 实现。

### 第 1 步：创建企业微信自建应用

1. 打开 [企业微信管理后台](https://work.weixin.qq.com) → **应用管理 → 自建 → 创建应用**
2. 填写应用名称、logo，创建后进入应用详情页
3. 记下 **AgentId** 和 **Secret**（Secret 只显示一次，丢失需重置）
4. 在「**我的企业 → 企业信息**」记下 **企业 ID**（CorpID）
5. 应用详情页下拉找到「**接收消息**」→ 启用 API 接收，自定义 Token 和 EncodingAESKey（43 字符随机串，自己生成或点「随机获取」按钮）。**此时回调 URL 先不填**，等云函数部署好后再填

### 第 2 步：在本机生成 OAuth1 token

```bash
# .env 已配好 GARMIN_USERNAME / GARMIN_PASSWORD 的话直接跑
npm run token
```

把输出的 `GARMIN_OAUTH1_TOKEN` 和 `GARMIN_OAUTH1_TOKEN_SECRET` 记下来（等同账号凭据，不要提交到仓库）。

### 第 3 步：本地构建 + 模拟测试

```bash
# 构建 CJS 产物（42KB，纯打包无 node_modules 依赖）
npm run build:scf

# 本地模拟 SCF 事件测试（覆盖 GET 验签、闲聊、Garmin 工具调用、POST 被动回复、/diag 诊断）
npm run test:scf
```

所有测试通过后，打包 zip：

```bash
npm run package:scf
# 产物：scf-dist/garmin-wecom-scf.zip（~13KB，index.js 在压缩包根目录）
```

### 第 4 步：腾讯云控制台创建函数

1. 打开 [腾讯云函数控制台](https://console.cloud.tencent.com/scf/list) 微信扫码登录（首次使用需个人实名认证，免费额度足够）
2. 左侧「函数服务」→ **新建**：
   - 函数类型：**事件函数**（不要选 Web 函数）
   - 函数名称：`garmin-wecom-bot`
   - 地域：**上海** 或广州（任选国内地域）
   - 运行环境：**Node.js 18.15**（20.x 也可）
   - 执行方法：`index.main`
   - 代码上传方式：**本地上传 zip** → 选刚才的 `garmin-wecom-scf.zip`
   - 高级配置：**执行超时改成 30 秒**（默认 3 秒不够），内存 128MB 即可
3. 环境变量：点「编辑 JSON」，把 [scf-dist/scf-env.json](file:///d:/mygit/garmin-wechat-report/scf-dist/scf-env.json) 的内容整段粘贴进去（10 个变量，已从你本地 `.env` 提取）
4. 点**完成**

### 第 5 步：开启公网访问地址

进入函数详情页 → **触发管理** → 找到「**函数 URL**」→ **创建**：
- 鉴权方式：**免鉴权**
- 得到 `https://xxxxx.ap-shanghai.tencentscf.com/...` 格式的地址

> 如果控制台只有"API 网关触发器"：新建一个，请求方式 ANY、鉴权免鉴权、发布 release，会得到 `...tencentcs.com/release/...` 地址，同样可用。

### 第 6 步：自检 + 配置回调 URL

1. 浏览器打开 `你的函数URL/diag`，确认 `config` 全是 `true`、`connectivity` 全 ok
2. 回到企业微信管理后台 → 你的自建应用 → 「接收消息」配置页
3. 回调 URL 填 `你的函数URL/wecom/callback`（Token / AESKey 保持第 1 步的值不变）
4. 点**保存**，应立即验证通过
5. 在企业微信 App 里打开该应用，发「你好」「我昨天走了多少步」验收

### 第 7 步（可选）：更新代码

代码更新后只需重复**构建 → 打包 → 上传 zip** 三步：

```bash
npm run typecheck
npm run package:scf
```

然后到腾讯云函数控制台 → **代码** 页签 → 上传新 zip → 保存。环境变量无需重新填。

### 常见问题

- **回调 URL 保存仍失败**：用 `/diag` 检查云函数是否正常运行；确认 `/wecom/callback` 路径正确；看腾讯云函数日志（控制台 → 日志查询）是否有请求到达
- **对话有回复但 Garmin 数据是旧的 / 报错**：检查 `GARMIN_OAUTH1_TOKEN` 是否过期，重跑 `npm run token` 更新环境变量
- **回复内容截断 / 不完整**：被动回复有 4096 字节限制，超长内容会被企业微信截断；可在 `handleUserMessage` 里对 AI 回复做截断
- **超时重试导致重复回复**：同实例 MsgId 去重已内置（TTL 60 秒）；不同实例间企业微信不会重试 POST 回调（被动回复 5 秒内返回即成功）
- **workers.dev 大陆不可达**：这是 Cloudflare 免费域名的网络阻断问题，不是代码 bug。定时日报 Worker 正常运行（Server酱推送单向出站），但对话回调必须用腾讯云函数等国内平台

## 如何修改推送内容

### 调整报告正文

报告的每一块都在 [src/report/formatter.ts](src/report/formatter.ts) 中，按区块拆分，改起来互不影响：

| 函数 | 对应报告区块 |
| --- | --- |
| `formatSleepSection` | 睡眠（昨晚） |
| `formatDailySection` | 每日健康总览 |
| `formatHealthSection` | 夜间生理指标（HRV） |
| `formatTrainingSection` | 训练负荷与恢复 |
| `formatTrendsSection` | 周度趋势对比 |
| `formatAdviceSection` | 今日建议（调用 [src/report/advice.ts](src/report/advice.ts) 规则引擎） |
| `formatReport` | 组装整篇报告，可在此调整区块顺序或增删区块 |

辅助函数 `row(label, value, suffix)` 用来生成一行 `- 标签: 值`；枚举到中文的映射表（如 `QUALIFIER_MAP`、`STATUS_MAP`、`ACWR_MAP`）也定义在该文件顶部，可直接改措辞。

一个最简单的例子：接口已经取到了「基础代谢卡路里」但报告里没展示，只需在 `formatDailySection` 中加几行：

```ts
if (d.bmrKilocalories !== null) {
  lines.push(row('基础代谢', String(d.bmrKilocalories), ' kcal'));
}
```

改完后本地 `DRY_RUN=1 npm start` 即可在终端预览效果（见 [.env.example](.env.example)）。

### 修改标题

推送标题在 [src/pipeline.ts](src/pipeline.ts) 中：

```ts
const title = `Garmin 日报 ${date}`;
```

注意 Server酱 的 `title` 不能包含换行。

### 调整推送参数或更换推送渠道

推送逻辑集中在 [src/notify/ftqq.ts](src/notify/ftqq.ts) 的 `pushReport(sendKey, title, desp)`：

- 想使用 Server酱 的多通道选择，可在请求体中追加其可选参数（如 `channel`），具体取值以 [Server酱文档](https://sct.ftqq.com/docs/) 为准。
- 想换成 Bark / 企业微信 / 飞书 / Telegram / 钉钉等，仿照 `ftqq.ts` 新建一个通知文件（同样导出接收 `(title, content)` 的函数），再把 [src/pipeline.ts](src/pipeline.ts) 中对 `pushReport` 的调用替换掉即可。例如 Bark 只需要：

```ts
export async function pushBark(deviceKey: string, title: string, content: string) {
  await fetch(`https://api.day.app/${deviceKey}/${encodeURIComponent(title)}/${encodeURIComponent(content)}`);
}
```

### 异常通知的内容

认证失败、任务异常时会分别从 [src/pipeline.ts](src/pipeline.ts) 和 [src/index.ts](src/index.ts) 推送「Garmin 日报登录失败」「Garmin 日报任务异常」通知，修改对应位置的标题和正文字符串即可。

## 数据怎么看：指标解读与参考建议

日报只负责呈现数据，下面给出各指标的常见参考区间和行动建议，可据此自行判断当天状态。**个体差异很大，最有价值的是与你自己的基线（以及周度趋势）对比；以下为一般性健康常识，不构成医疗建议。**

### 睡眠

- **总时长**：成人通常建议 7–9 小时。长期低于 6 小时会累积睡眠债，建议固定入睡时间、睡前减少咖啡因与屏幕蓝光。
- **睡眠评分**：优秀 / 良好即可，单日波动正常；连续走低再重点排查作息、饮酒、晚餐过晚等因素。
- **阶段占比**：健康成人深睡约占 13%–23%、REM 约 20%–25%。深睡偏少常见于睡前饮酒、入睡过晚、睡眠碎片化；REM 偏少常与总时长不足有关（REM 集中在后半夜）。
- **清醒时长**占比明显偏高说明夜醒多，注意室温、噪音与睡前压力。
- **睡眠压力**偏高、身体电量夜间充电不足，提示睡眠质量差，即使躺够时间也要减负。

### 心率与 HRV

- **静息心率**：与自己平时的水平比较。晨起静息心率比基线高出 5–10 bpm 以上，常提示疲劳、压力、饮酒或感冒早期，当天适合降低训练强度。
- **夜间 HRV**：不要和别人比，只看 `基线区间`。连续多天低于基线（状态显示「失衡 / 低」）通常意味着恢复不足或压力累积；单日波动不必紧张。
- HRV 回升、静息心率回落，是恢复完成的积极信号。

### 压力与身体电量

- 全天**平均压力**长期偏高、身体电量**充电少 / 消耗多**：增加放松和午休，检查睡眠与咖啡因摄入。
- 早晨起床身体电量长期低于 50，说明夜间恢复不充分，高强度训练应顺延。

### 训练负荷与恢复

- **训练准备度**：高分（High，通常 ≥80）适合安排高强度或比赛；中等（Moderate）适合常规训练；低 / 很低（Low / Very Low）建议恢复性活动：散步、轻松骑行、拉伸。
- **建议恢复时间**：Garmin 根据上次大强度活动估算，未归零前避免再次堆高强度课。
- **急慢性负荷比 ACWR**：常用经验安全区间约 0.8–1.5。报告显示「过高 / VERY_HIGH」时短期伤病风险上升，应减量；长期「过低」则说明刺激不足、体能可能退步。
- **训练状态**：「过度训练 / 过度疲劳（OVERREACHING / STRAINED）」连续出现时安排减量周；「停训退步（DETRAINING）」提示需要恢复规律训练。
- **VO2max**：看长期趋势（数周），持续缓慢上升是心肺改善的信号；短期下跳先排查疲劳与睡眠。

### 血氧

健康成人夜间平均血氧通常在 94% 以上。手表受佩戴松紧、睡姿影响会有误差，**偶发低值不必恐慌；但若多次稳定低于 90%，建议使用医疗设备复测并咨询医生**。

### 使用建议小结

- 单日异常先观察，**连续 2–3 天同向变化**才值得行动。
- 周度趋势表中，HRV ↓ + 静息心率 ↑ + 睡眠评分 ↓ 同时出现，是明确的「该休息」组合。
- 身体不适期间以主观感受为准，不要硬凑步数和强度分钟目标。

## 今日建议：内置规则引擎与可选 AI 分析

报告末尾的「今日建议」默认由**内置规则引擎**离线生成，不依赖任何外部服务；此外项目还**内置了可选的 AI 健康分析**，配置 API Key 后会在规则建议之后再追加一段大模型生成的个性化自然语言建议。两者默认共存（规则建议在前、AI 建议在后），也可以按需只保留其一。

### 内置规则引擎（默认开启，离线运行）

规则引擎在 [src/report/advice.ts](src/report/advice.ts) 中，是一个纯函数：输入结构化的 `ReportData`，输出建议文案数组，再由 `formatAdviceSection` 渲染为报告最后的区块。全程不联网、不发送数据、不产生费用，Node 与 Cloudflare Workers 行为一致。

内置规则（触发条件 → 建议方向）：

| 指标 | 触发条件 | 建议方向 |
| --- | --- | --- |
| 血氧 | 夜间 / 当日最低值 < 90% | 用医疗设备复测并咨询医生（最高优先级） |
| HRV | 低于个人基线区间，或状态为 `UNBALANCED` | 减压早睡、避免叠加高强度训练 |
| 训练准备度 | < 50 / ≥ 80 | 以恢复性活动为主 / 适合高质量高强度训练 |
| ACWR | > 1.5（或状态 HIGH/VERY_HIGH）/ < 0.8（或 LOW/VERY_LOW） | 减量防伤 / 逐步加量 |
| 训练状态 | `OVERREACHING` / `STRAINED` | 安排减量周 |
| 身体电量 | 夜间充电 < 50 | 高强度训练顺延 |
| 静息心率 | 较 7 天前上升 ≥ 5 bpm | 警惕疲劳、压力或感冒早期 |
| HRV 趋势 | 较 7 天前下降 > 15% | 减轻负荷 |
| 睡眠时长 | 不足 6 小时；或较 7 天前减少 ≥ 1.5 小时 | 安排午休、提前入睡 |
| 睡眠评分 | < 60 | 排查作息、饮酒、睡前压力 |
| 睡眠结构 | 深睡占比 < 13% / REM < 18% / 清醒 > 10% | 针对性改善睡眠卫生 |
| 睡眠压力 | > 40 | 降低当日运动强度 |
| 日均压力 | > 50 | 深呼吸放松、减少咖啡因 |
| 步数 | 不足目标的 50% | 饭后散步 20–30 分钟 |
| 全部正常 | 无规则命中 | 输出一条正向小结 |

其他设计细节：

- 每条建议带优先级（血氧告警 > 恢复/训练 > 睡眠/压力 > 活动/趋势 > 正向反馈），最终按优先级排序，最多展示 6 条（`MAX_TIPS`），保证最重要的提醒不被淹没。
- 当天所有数据接口都失败、没有任何可用数据时，该区块自动隐藏，不会出现空板块。
- 建议文案末尾固定附带「由本地规则引擎根据固定阈值自动生成，仅供参考，不构成医疗建议」声明。

**调整阈值或新增规则**：直接编辑 [src/report/advice.ts](src/report/advice.ts)，仿照现有 `if` 块向 `tips` 数组 `push({ priority, text })` 即可，可用字段见 [src/report/types.ts](src/report/types.ts)。阈值均为通用参考值，建议结合自己的基线修改（例如你的静息心率常年在 70 以上，就不应套用固定阈值，而应优先使用与 7 天前 / 基线对比的规则）。改完执行 `npm run typecheck` 和 `DRY_RUN=1 npm start` 验证。

**关闭规则引擎**：删除 [src/report/formatter.ts](src/report/formatter.ts) 中 `formatReport` 里调用 `formatAdviceSection` 的几行（同时移除文件顶部的 `import { generateAdvice } ...`）即可；不需要改动其他文件。

### AI 健康分析（可选，已内置）

除了离线规则建议，项目还**内置**了大模型（AI）分析：在 Markdown 报告生成之后、推送之前，把完整日报发送给任意 OpenAI 兼容服务，由模型针对明显偏离个人基线的指标输出 3–5 条中文短句，并以「AI 健康建议」区块追加到报告末尾。调用逻辑在 [src/ai/advice.ts](src/ai/advice.ts)，挂载点在 [src/pipeline.ts](src/pipeline.ts) 中 `formatReport` 之后；全程使用原生 `fetch`，无 SDK 依赖，Node 与 Workers 均可运行。

**开启方式**：只需配置 `AI_API_KEY`。未配置时整个 AI 步骤自动跳过，行为与纯规则引擎完全一致。

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `AI_API_KEY` | 开启时必填 | — | 服务商 API Key；未配置则不调用 AI |
| `AI_BASE_URL` | 否 | `https://api.deepseek.com` | OpenAI 兼容接口地址（注意部分服务商需要带 `/v1`） |
| `AI_MODEL` | 否 | `deepseek-chat` | 模型名 |

常见兼容服务配置：

| 服务 | `AI_BASE_URL` | `AI_MODEL` 示例 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Moonshot Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |

**三种运行方式分别如何配置**（代码均已接线，无需改代码）：

- **本地运行**：在 `.env` 中填写上述三个变量即可，[.env.example](.env.example) 已预留；[src/index.ts](src/index.ts) 会自动读取并传入 `runPipeline`。
- **GitHub Actions**：在 **Settings → Secrets and variables → Actions** 添加 `AI_API_KEY`（需要换服务商时再加 `AI_BASE_URL`、`AI_MODEL`）。[.github/workflows/daily-report.yml](.github/workflows/daily-report.yml) 的 **Run report** 步骤已透传这三个变量，添加 secret 后下一次运行即生效。
- **Cloudflare Workers**：执行 `npx wrangler secret put AI_API_KEY` 写入密钥；`AI_BASE_URL`、`AI_MODEL` 已预置在 [wrangler.toml](wrangler.toml) 的 `[vars]` 段，直接改默认值即可，[src/worker.ts](src/worker.ts) 已完成读取。

**行为与定制**：

- AI 接口超时、报错或返回空内容时，错误只写入运行日志（`AI 分析失败，跳过`），**不影响主报告生成与微信推送**。
- AI 区块末尾固定附带「以上建议由 AI 生成，仅供参考，不构成医疗建议」声明。
- 想调整分析风格、条数或提示词：修改 [src/ai/advice.ts](src/ai/advice.ts) 中的 system message 与 `temperature`。
- 想让 AI 建议**替换**而非追加规则建议：在 [src/report/formatter.ts](src/report/formatter.ts) 的 `formatReport` 中去掉 `formatAdviceSection` 调用即可。

> 隐私提示：开启 AI 后，你的健康数据（日报正文）会发送给第三方 AI 服务商，请先确认其隐私政策。日报本身不含姓名等身份信息；如仍介意，可在 [src/pipeline.ts](src/pipeline.ts) 调用 `generateAdvice` 前对报告内容做裁剪。

## Fork 后二次开发指南

### 目录结构

```
.github/workflows/daily-report.yml  GitHub Actions 定时任务
scripts/bootstrap-token.ts          本机生成 OAuth1 长效 token
scripts/scf-local-test.ts           SCF 本地模拟事件测试
src/index.ts                        Node 入口（本地 / Actions）
src/worker.ts                       Cloudflare Workers 入口（Cron + /run + /wecom/callback）
src/pipeline.ts                     核心编排：认证 → 拉数 → 渲染 → 推送
src/garmin/auth.ts                  SSO 登录 + OAuth1 → OAuth2 认证链
src/garmin/oauth.ts                 OAuth1 签名工具
src/garmin/api.ts                   各接口的请求与字段解析
src/garmin/endpoints.ts             Garmin API 路径常量
src/report/formatter.ts             Markdown 报告渲染
src/report/advice.ts                本地规则引擎：生成「今日建议」
src/report/types.ts                 全部数据类型定义
src/ai/advice.ts                    可选 AI 健康建议（OpenAI 兼容接口）
src/wecom/callback.ts               企业微信消息回调（Worker）
src/wecom/crypto.ts                 企业微信加解密（SHA-1 + AES-256-CBC + 32B 块填充）
src/wecom/chat.ts                   对话主循环（LLM + tool_call 调度）
src/wecom/api.ts                    企业微信 send API（仅 Worker 备用，SCF 不依赖）
src/wecom/types.ts                  WeComChatEnv 类型定义
src/scf/handler.ts                  腾讯云函数 SCF 入口（事件函数，GET/POST/diag）
src/notify/ftqq.ts                  Server酱推送
src/notify/wecom.ts                 企业微信群机器人推送
src/utils/time.ts                   时区 / 日期 / 时长格式化
wrangler.toml                       Cloudflare Workers 配置
```

### 核心数据流

**定时日报路径**：

1. 入口读取环境变量，组装 `PipelineConfig` 调用 `runPipeline`（[src/pipeline.ts](src/pipeline.ts)）。
2. `GarminAuth` 完成认证（账号密码走 SSO；有 token 则直连换取会话）。
3. `GarminApi` 用 `Promise.allSettled` **并发**拉取当日五类数据，单个接口失败不影响其他区块（失败信息进入 `xxxError` 字段，报告中显示「拉取失败」）。
4. 再拉取 7 天前数据，用 `buildTrend` 计算周度趋势。
5. `formatReport` 渲染 Markdown，末尾通过规则引擎生成「今日建议」；若配置了 `AI_API_KEY`，再调用 [src/ai/advice.ts](src/ai/advice.ts) 在报告末尾追加「AI 健康建议」区块（AI 失败只记日志、不影响推送），最后通过 `pushReport` 推送到 Server酱 / 企业微信。

**企业微信对话路径**：

1. 企业微信服务器向 `/wecom/callback` 发送 POST（含加密 XML）。
2. `verifySignature` 验签 → `decryptMessage` 解密拿到明文 XML。
3. `handleUserMessage` 进入 LLM 主循环：解析用户意图 → 按需调用 Garmin API（步数 / 睡眠 / HRV / 训练数据）→ 返回自然语言回复。
4. `buildTextReplyBodyXml` 构造回复消息体 XML → `encryptMessage` 加密 → 拼外层 XML（Encrypt + MsgSignature + TimeStamp + Nonce）→ 直接作为 POST 响应体返回。

### 新增一个数据指标的完整链路

以新增「饮水（hydration）」区块为例，按数据流向依次改 5 个文件：

1. **加接口路径** — [src/garmin/endpoints.ts](src/garmin/endpoints.ts)：

   ```ts
   hydration: (date: string) =>
     `/usersummary-service/usersummary/hydration?calendarDate=${date}`,
   ```

2. **加类型** — [src/report/types.ts](src/report/types.ts)：定义 `HydrationData` 接口，并在 `ReportData` 中加 `hydration: HydrationData | null` 与 `hydrationError: string | null`。

3. **加请求与解析** — [src/garmin/api.ts](src/garmin/api.ts)：仿照 `getSleep` 写 `getHydration(date)`，先定义只包含所需字段的 `RawXxx` 接口，缺失值统一归一成 `null`。

4. **接入编排** — [src/pipeline.ts](src/pipeline.ts)：在 `Promise.allSettled([...])` 中加 `api.getHydration(date)`，用同样的 `settled()` 拆出值和错误，塞进 `reportData`。

5. **渲染** — [src/report/formatter.ts](src/report/formatter.ts)：写 `formatHydrationSection(data)`（先判 `hydrationError`，再判空数据），并在 `formatReport` 中插入到想要的位置。

只是「已有字段想展示 / 改措辞」则只需改第 5 步（参考上文基础代谢的例子）。

### 运行时兼容约束

- `src/` 下的共享代码会同时跑在 Node 和 Cloudflare Workers 上，**只能使用 `fetch`、Web Crypto、`Intl` 等跨平台能力**，不要引入 `node:fs`、`node:process` 等内置模块；这类用法只允许出现在 [src/index.ts](src/index.ts) 和 `scripts/` 中。
- 项目为 ESM，相对路径导入要带 `.js` 后缀（如 `import { GarminAuth } from './garmin/auth.js'`），即使源文件是 `.ts`。
- Garmin 接口字段可能变动，新增解析时对不存在的字段保持宽容（`?? null`），避免整个任务崩溃。

### 调试与自检

```bash
# 类型检查，提交前必跑
npm run typecheck

# 只生成不推送，报告打印在终端
DRY_RUN=1 npm start          # Windows PowerShell: $env:DRY_RUN=1; npm start

# Worker 本地调试，支持补跑历史日期
npm run worker:dev
# 浏览器访问 http://localhost:8787/run?date=2026-09-10
```

### 同步上游更新

Fork 后自己改代码的同时，想合并上游仓库 [caifugao110/garmin-wechat-report](https://github.com/caifugao110/garmin-wechat-report) 的后续更新：

```bash
git remote add upstream https://github.com/caifugao110/garmin-wechat-report.git
git fetch upstream
git merge upstream/main      # 如有冲突，多发生在 README、workflow、formatter
```

建议自定义内容尽量集中在新增文件中，减少与上游的合并冲突。

## 常见问题

**收到「Garmin 日报登录失败：未拿到 ticket」？**
账号密码错误、开启了两步验证，或登录 IP 被风控。本地浏览器登录一次确认账号状态；
CI 环境改用上文的 OAuth1 token 方案。

**收到 HTTP 429？**
短时间内登录过于频繁被限流，等待一段时间后再触发，避免反复手动运行；
同时部署了 Actions 和 Workers 的话，把两边的 cron 时间错开。

**Actions 运行成功但没收到微信推送？**
检查 `SERVERCHAN_SENDKEY` 是否正确、SendKey 是否过期；任务日志中会打印「推送结果：成功 / 失败原因」。
本地可设 `DRY_RUN=1` 先确认报告生成正常。

**Actions 页面没有定时运行记录？**
检查 workflow 是否处于 Disabled 状态；Fork 仓库需手动启用一次 Actions；
仓库超过 60 天无活动定时任务会被 GitHub 自动暂停，推送一次提交或重新启用即可。
已配置 07:50 备用触发：若 07:40 的主触发被 GitHub 丢弃，备用触发会在检测到当天无成功记录后自动补发；
如果两个时间点都没有任何运行记录，再按上述几项排查。

**某些区块显示「拉取失败」或 N/A？**
单项接口失败不会影响其他数据。可能是当天该类数据尚未同步（早晨太早、手表未同步），
或 Garmin 调整了接口字段；可先用 `?date=` 补跑历史日期确认，持续失败再检查 [src/garmin/api.ts](src/garmin/api.ts) 的字段解析。

**企业微信回调 URL 保存报「请求不通过」？**
最常见原因是回调地址的域名在国内不可达。`*.workers.dev` 免费域名在中国大陆被网络阻断，
企业微信验证服务器（国内）无法连接。必须改用国内可直连的平台：腾讯云函数 SCF（本项目推荐方案，
与企业微信同生态、自带国内 HTTPS 地址）、阿里云函数计算、或自建服务器。详见上文「腾讯云函数 SCF 部署」。

**企业微信发消息报 errcode=60020「not allow to access from your ip」？**
这是走主动推送（send API）时出现的 IP 白名单限制。Cloudflare Workers 出口 IP 池不可预测、
腾讯云函数 NAT 池被标记为"第三方服务商 IP"，均无法加入可信 IP 白名单。
本项目对话路径已改用**被动回复架构**（在 POST 响应里返回加密 XML），零出站调用，完全绕开此限制。
如果你在别处仍遇到 60020，要么改走被动回复，要么给 send API 所在的服务器绑定固定公网 IP 并加入白名单。

**腾讯云函数更新代码后没有反应？**
重新上传 zip 后需点「保存」才会生效。如果仍有问题，到函数控制台的「日志查询」查看最新运行日志，
或访问 `/diag` 确认云函数本身正常、环境变量齐全。

## 免责声明

本项目为非官方个人工具，与 Garmin 无关。Garmin 接口如有变动可能导致不可用，使用风险自负。
报告中的数据与建议（包括 AI 生成内容）仅供健康管理参考，不构成医疗诊断或治疗建议。

## License

[MIT](LICENSE) © Tobin
