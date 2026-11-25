---
status: accepted
---

# 根目录放置 `wrangler.jsonc` 并将根 `build` 脚本指向 Worker

Cloudflare 的「Deploy to Cloudflare」按钮若指向仓库子目录（`/tree/main/worker`），只会复制该子目录，无法引用同仓库的 `packages/*` 工作区。按钮可从根 `package.json` 读取 `build` 和 `deploy` 脚本预填命令。因此 `wrangler.jsonc` 放在仓库根目录，指向 `worker/` 的入口、静态产物与 D1 迁移目录；根 `build` 构建 `@subboost/worker`，`deploy` 先迁移 D1 再部署，`check:worker` 执行门禁，原版仍可用 `local:build`。

## 备选方案

- **将 `wrangler.jsonc` 置于 `worker/` 子目录**：要么一键部署按钮因缺少 `packages/*` 构建失败，要么要求用户在部署向导手动配置 Root Directory 与自定义构建命令，无法实现真正的零配置一键部署。

## 影响

- 同步上游时，按[同步手册](../upstream-sync-guide.md)保留根 Wrangler 配置以及 `package.json` 的 Worker 工作区、脚本和部署绑定元数据。
- CLI 路径已通过线上测试资源验证；按钮实际如何解析分支、初始化 D1 和注入密钥仍须走向导验收。
