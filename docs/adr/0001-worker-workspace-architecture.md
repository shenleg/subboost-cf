---
status: accepted
---

# 独立 `worker/` 工作区与 Vite SPA + Hono Worker 架构

为降低 Cloudflare Workers 的运行开销，以及追踪上游 `SubBoost/subboost` 时的合并冲突，我们新增独立的 `worker/` 工作区，保持 `local/` 与 `packages/*` 尽量原样不动。前端通过薄的 Next.js 兼容 shim 直接编译上游 `packages/ui` 为 Vite 静态资源，由 Workers Static Assets 托管，不执行 SSR，也不计入 Worker 脚本包。后端由 Hono Worker 直接复用 `@subboost/core` 与 `@subboost/server-core`。

免费版的 CPU 和外部子请求额度是设计约束，不是达标承诺。脚本仍采用项目的 gzip `< 3 MB` 门禁；现行平台体积限制及两者的区别见[部署指南](../cloudflare-workers.md#免费版预算与验证边界)。

## 备选方案

- **原地改造 `local/` + `@opennextjs/cloudflare`**：虽然能沿用 Next.js 壳子，但会增加运行时体积与 CPU 开销。上游升级 Next.js 时也可能需要调整适配，原地改动 `local/` 会扩大同步冲突面。

## 影响

- `worker/` 直接引用上游共享包，常规更新无需移植副本；合并后仍按[同步门禁](../upstream-sync-guide.md#3-放行门禁)验证兼容性。
- `worker/` 只需维护面向 Cloudflare 运行时的薄适配层（D1 存储、Hono 路由、Next.js 3 个 UI API shim、Cron 入口），当上游在 `local/` 新增 API 路由或 Prisma 表结构变更时需同步移植到 `worker/`。
