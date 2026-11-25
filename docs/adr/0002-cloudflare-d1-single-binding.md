---
status: accepted
---

# 全量使用 Cloudflare D1 单一数据绑定

为了实现零外部账号依赖的“一键部署到 Cloudflare”，Worker 版本将原版 PostgreSQL 的全部 6 张业务表（`LocalAdmin`、`LocalTemplate`、`Subscription`、`SubscriptionAutoUpdateState`、`JobLeaseLock`、`RevokedSession`）以及原版存于进程内存的远程规则索引缓存，统一存储在单个 Cloudflare D1（SQLite）数据库中。

## 备选方案

- **D1 + Cloudflare KV**：需要多绑定一个 KV 命名空间，增加部署配置与维护复杂度。本版用 D1 持久化缓存，公开订阅限流保留在内存，避免访问量等比例消耗 D1 写额度。
- **外部免费 PostgreSQL（Neon/Supabase）+ Hyperdrive**：虽可复用 Prisma，但用户需要额外注册第三方数据库平台并手动填写连接串，破坏单账号一键部署体验。

## 影响

- Worker 只绑定一个 D1。部署按钮负责创建并绑定数据库，部署脚本才负责执行 SQL 迁移；CLI 已实测首发迁移，不能据此推定向导也已验证。
- 原版依赖 PostgreSQL 语法或 Prisma 数据模型的部分，由 `worker/` 以 SQLite SQL 和 D1 绑定适配。表映射、Worker 专属运行表见 [Parity Map](../worker-parity.json)。
