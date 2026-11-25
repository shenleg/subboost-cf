# 上游同步操作手册

本指南供贡献者验证上游同步变更，也提供自动化工具可匹配的路径与契约规则。不实现机器人，不授予发布权限。上游为 [`SubBoost/subboost`](https://github.com/SubBoost/subboost)；原版模型和 Worker 的差异见机器可读 [Parity Map](worker-parity.json)，仓库边界及门禁见[区域清单](upstream-sync-zones.json)。

## 1. 获取并检查上游变更

在干净的独立 worktree 建同步分支，保留当前 Fork 集成分支作为起点。让 `upstream` 指向公开上游仓库，从该 remote 获取实际跟踪分支（以下以 `main` 为例）。比较共同祖先到上游的新改动，而不是用两棵树的直接 diff 把既有 Worker 差异算作上游变更。

```bash
git fetch upstream main
git diff --name-status --find-renames HEAD...upstream/main
git diff HEAD...upstream/main
```

1. 按[区域清单](upstream-sync-zones.json)分类，重命名要同时检查新旧路径。没有规则的路径视为共享区并转人工。
2. 用 [Parity Map](worker-parity.json) 对照上游 API 方法和参数、响应/Cookie、表和字段、页面、Next 接口及环境变量。`local/app/api/**/route.ts`、`local/prisma/**`、`local/app/**/page.tsx`、`packages/ui/**` 等即使属于只读区也要做此检查；无文本冲突不代表 Worker 契约兼容。
3. 仅改共享纯逻辑且契约不变：合并后直接验证。遇到 API、新表/字段、变量、页面行为或仅 Node/Next 可用的依赖：先在 `worker/` 同步适配，必要时新增有序 D1 SQL 和顶层 HTTP/Cron 契约测试，并更新 Parity Map。若无法判断兼容性或会改变认证、数据或免费配额行为，转人工，不自动发布。

## 2. 合并与冲突裁决

把 `upstream/main` 合入同步分支，不直接操作 Fork 集成分支。冲突逐文件处理，不全局选 `ours` 或 `theirs`，不使用强制重置或推送。

| 区域 | 裁决 |
| --- | --- |
| 上游只读 | `local/`、`packages/`、`.github/` 等采用上游实现；不能为 Worker 修改这些区域。在 Worker 路由、D1 适配、SPA 或 shim 补齐差异。 |
| Worker 专属 | 保留 `worker/`、根 Wrangler 配置、密钥示例及部署/同步文档；上游如果新增同名文件，暂停并提交人工审查。已经上线的 D1 迁移不改写，按序追加。 |
| 共享 | 根 `package.json` 吸收上游变更并重放 Worker 工作区、命令、绑定元数据；保留原版 `local:build`。由 npm 重新生成有冲突的锁文件，再用 `npm ci` 验证。保留 `.gitignore` 的 Wrangler/本地密钥规则。双语 README 采用上游正文，只重放头部 Workers 横幅。其余不明确的冲突转人工。 |

## 3. 放行门禁

```bash
npm ci
npx playwright install chromium # 首次运行门禁前安装；浏览器版本不变时无需重复
npm run check:worker
```

- `check:worker` 依次运行 Worker/SPA 类型检查、真实本地 D1 的 Worker HTTP/Cron 测试、Vite 生产构建（只构建一次）、Chromium 冒烟、Wrangler 干跑和 gzip 门禁、Prisma Client 生成、完整原版 Vitest 回归（包含 `test/regression/` 扩展用例，不采集覆盖率）。没有体积报告或不能确定 gzip 严格小于 **3,000,000 字节**都视为失败。
- Chromium 冒烟使用生产静态资源与同源 API 替身；公开路由、登录和初始化、设置页面、订阅一键接续刷新等由浏览器实际渲染并交互。另可用 `worker:dev` 与本地 D1 验证真实同源连接。
- 检查提交 diff 符合区域规则，原版 Docker/Next 入口、README 正文、AGPL 许可与源码链接仍有效。失败则停下来修复或交人工。通过只代表可以提交同步结果供审核，不代表已验证云端 CPU、部署向导或可自动发布。禁止从门禁运行远端迁移、创建资源或上传预览；参见[部署指南](cloudflare-workers.md)。

本项目采用 [AGPL-3.0-only](../LICENSE)。对外提供修改版服务时须提供对应源码；上游源码：[SubBoost/subboost](https://github.com/SubBoost/subboost)。
