---
status: accepted
---

# Web Crypto PBKDF2-SHA256 密码哈希与单密钥极简初始化

Worker 版以 Web Crypto 的原生 `PBKDF2-SHA256`（100,000 次迭代）替代原版 JavaScript `bcryptjs`（cost 12），以降低密码哈希的运行开销。

默认只需配置 `ENCRYPTION_KEY`：未显式设置 `JWT_SECRET` 时通过 HKDF 域分离派生会话签名密钥；原生 `scheduled()` 不依赖 `CRON_SECRET`；管理员可直接在网页初始化，`LOCAL_SETUP_TOKEN` 是可选的首访保护。管理员创建成功后，初始化接口返回 `409 Conflict`。

**线上验证（2026-11-25）：**独立测试 Worker 的初始化为 26 ms CPU，三次成功登录为 22、26、35 ms。这些是整个请求的 Cloudflare CPU 耗时，不能单独归因于 PBKDF2；但都超过了 Workers Free 的 10 ms 目标，不能用 HTTP 成功或本地测试证明免费版达标。

## 备选方案

- **保留 `bcryptjs`**：虽然能延用原版密码哈希格式，但将纯 JavaScript 密码计算留在 Worker 请求内，不符合降低 CPU 开销的目标。
- **强制要求 `LOCAL_SETUP_TOKEN`（或原版 4 个必填密钥）**：可消除部署完成到首次访问前的短暂窗口期风险，但用户一键部署时需要额外手动生成并管理多个随机口令，偏离极简一键部署目标。

## 影响

- Worker 版的密码哈希格式与原版 PostgreSQL 的 bcrypt 哈希不互通（本次不涉及旧库迁移）。
- 若用户希望防止公网域名首次上线时的抢注窗口，可在部署时主动配置可选环境变量 `LOCAL_SETUP_TOKEN`，系统将自动启用令牌校验。
