# Cloudflare Workers 部署指南

SubBoost Workers 版使用 Workers Static Assets、单个 D1 数据库和原生 Cron，不需要 Docker 或 PostgreSQL。适合全新部署，不支持从原版 PostgreSQL 直接迁移数据。

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shenleg/subboost)

1. 登录 Cloudflare 和 GitHub，按向导选择账号与新仓库。使用包含 Worker 配置的公开仓库默认分支；本票分支未发布时，按钮不会读取本地代码。构建目录保留向导默认的仓库根，不要改成 `worker/`，否则会缺少共享工作区。
2. 用 `openssl rand -hex 32` 生成 `ENCRYPTION_KEY`，填到向导的 Worker **Secret**，并安全备份。只需这一个密钥。不要提交密钥，也不要只把它添加为构建变量。如需防止首访被抢先注册，可在开放访问前额外添加 `LOCAL_SETUP_TOKEN`。
3. 使用预填构建和部署命令。Cloudflare 读取根 `wrangler.jsonc`，创建并绑定一个 D1，替换模板库 ID。构建执行根 `build`，得到 `worker/dist`；根 `deploy` 先以绑定名 `DB` 执行远端迁移，再部署 Worker。SQL 失败时不会继续部署。若另行配置 Workers Builds 或自定义 API token，需确认它同时有目标账号的 Worker 部署和 D1 迁移写权限。
4. 打开 `/api/health/ready`，确认返回 `200`、`database: "ready"`；再访问 `/login` 创建唯一管理员。有初始化令牌时，按页面提示输入。初始化成功后不能再次创建管理员。

Cloudflare 按钮的资源供给和脚本预填见[官方文档](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。本仓库已在本地验证构建、迁移和请求契约；按钮向导实际替换 D1 ID、首迁移凭证和首发密钥注入仍需获准后的线上验证。

## 本地开发（Wrangler）

在仓库根目录，以 `package.json` 的 `engines.node` 为准安装 Node.js 和 npm。

```bash
npm ci
cp -n .dev.vars.example .dev.vars
# 编辑 .dev.vars，为 ENCRYPTION_KEY 填入 openssl rand -hex 32 的输出。
npm run worker:dev
```

该命令先构建 Vite 静态资源，再执行 `wrangler d1 migrations apply DB --local`，最后启动 `wrangler dev`。默认访问 `http://localhost:8787`。本地 D1 由 Wrangler 持久化在 `.wrangler/`，不写远端；无须 Cloudflare 登录或真实 D1 ID。修改 SPA 源码后重新运行 `npm run build` 生成静态资源。相同的本地迁移可以重复运行。

## CLI 首次发布与后续升级

以下命令会创建或写入真实 Cloudflare 资源。只对你获准部署的账号和数据库执行，不用于测试或干跑。

```bash
npm ci
npx wrangler login
npx wrangler d1 create subboost
```

在根 `wrangler.jsonc` 中，把全零模板 `database_id` 改成创建命令返回的真实 ID；保留绑定名 `DB`，如果库名不同，同步更新 `database_name`。不要将实际 ID 提交回公共模板。把 `ENCRYPTION_KEY` 放进本机忽略文件，例如 `.env.worker-production`（同样可含可选的 `LOCAL_SETUP_TOKEN`，但不要复用本地开发值）。首次发布时随 Worker 上传：

```bash
npm run build
npm run deploy -- --secrets-file .env.worker-production
```

后续升级保留原 D1 ID 和线上密钥，运行 `npm run build && npm run deploy`。不要直接运行 `wrangler deploy` 来升级，否则不会先应用 SQL。不要用 `npm run deploy -- --dry-run`，因为它仍会先跑远端迁移；只想本地验证时执行 `npm run check:worker`（首次运行前用 `npx playwright install chromium` 安装浏览器），或构建后单独执行 `npm run worker:dry-run`。

## 域名、调度与排障

- **自定义域名**：在 Worker 的 **Settings → Domains & Routes** 添加域名。默认从请求 URL 推导站点地址、Cookie 安全属性和订阅公开链接，一般不用配置 `APP_URL`。只有需要固定规范域名时才显式设置合法的 HTTPS `APP_URL`。
- **探活与就绪**：`GET /api/health/live` 只检查 Worker 存活；`GET /api/health/ready` 还检查密钥和当前完整迁移的 D1 表。返回 `ENCRYPTION_KEY_MISSING` 时，到 **Workers & Pages → 该 Worker → Settings → Variables and Secrets** 添加 `ENCRYPTION_KEY`，选择 **Secret** 并使变更生效；不要随意更换已有数据的加密密钥。若返回 `database: "unavailable"`，核对 `DB` 的 ID 与迁移结果；升级时确认包括 `0002_subscription_cron.sql` 和 `0003_manual_refresh.sql` 在内的迁移均已应用。
- **自动刷新**：订阅每 6 分钟检查一轮，规则索引每 6 小时刷新。`CRON_BATCH_SIZE` 默认 3（可设 1–5，超过 5 按 5）；`CRON_FETCH_LIMIT` 默认 50（有效范围 20–50，超过 50 按 50，小于 20 或无效值回退默认）。重试和重定向逐次计入外部请求预算。原生 Cron 不需要 `CRON_SECRET`；若要手动调用 HTTP Cron，才添加该 Secret 并使用 `Authorization: Bearer …`，未配置时 HTTP Cron 拒绝调用。
- **订阅源**：Worker 在 Cloudflare 边缘运行，不能访问你的局域网；打开账户里的订阅源安全开关也不会开放这一能力。
- **其他变量**：`JWT_SECRET` 可覆盖从 `ENCRYPTION_KEY` 派生的会话签名密钥；`RELEASE_REPO` 可覆盖默认的 `SubBoost/subboost` 版本检查目标。全部部署差异见 [Parity Map](worker-parity.json)。
- **手动刷新**：仪表盘一次点击自动续跑超出单次出站预算的订阅；成功前不会发布部分快照。直接调用 HTTP 的客户端收到 `202 SUBSCRIPTION_REFRESH_PENDING` 时，用响应里的 `continuation` 作为 `X-SubBoost-Refresh-Continuation` 请求头再次 POST 同一地址。令牌限当前订阅版本和阶段，有效期 10 分钟；令牌丢失时，不带该请求头重新 POST 可接续仍有效的当前版本。
- **模板上传**：请求最多 4 MiB；保存时配置须加密为约两倍 UTF-8 字节数的 v2 密文，加上元数据后受 D1 单行 2,000,000 字节限制。若收到 `413 PAYLOAD_TOO_LARGE`，请缩小模板配置；可保存的配置通常不到 1 MB。

## 免费版预算与验证边界

[Workers Free](https://developers.cloudflare.com/workers/platform/limits/) 目前每次调用最多 **10 ms CPU**、**50 次外部子请求**（D1 不算外部子请求），每账号最多 5 个 Cron 触发器；[D1 Free](https://developers.cloudflare.com/d1/platform/limits/) 每次调用最多 50 次 D1 查询（一次 `batch()` 算一次），每日 500 万行读、10 万行写、总存储 5 GB。脚本平台限制是 [64 MiB 未压缩](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/)；本项目另保留 **gzip 严格小于 3 MB（3,000,000 字节）** 的发布门禁，以 Wrangler 的整个 Worker 上传体积为准，不把独立托管的 SPA 静态文件算进脚本。真实 Chromium 和 Wrangler 干跑均不能证明 Cloudflare 云端 CPU 达标；部署获准后，应从平台指标检查登录、首次初始化以及典型和较大订阅的 Cron CPU。

本项目采用 [AGPL-3.0-only](../LICENSE)。若修改后通过网络提供服务，须向使用者提供对应源码；上游源码：[SubBoost/subboost](https://github.com/SubBoost/subboost)。
