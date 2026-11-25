// 提供无需会话的存活和就绪检查。
import { Hono } from "hono";
import { ENCRYPTION_KEY_MISSING, getEncryptionKey, type WorkerApp } from "../env";

/** 挂在 `/api` 下的 Worker 健康检查路由。 */
export const healthRoutes = new Hono<WorkerApp>()
  .get("/health/live", (c) => c.json({ ok: true, service: "subboost-worker" }))
  .get("/health/ready", async (c) => {
    if (!getEncryptionKey(c.env)) return c.json({ ok: false, ...ENCRYPTION_KEY_MISSING }, 503);
    try {
      // LIMIT 0 仍要求 SQLite 解析所有表和字段，但不读取数据；空库完成迁移也应就绪。
      await c.env.DB.prepare(`SELECT a.passwordHash, t.encryptedConfig, s.revision, u.failureSourceState,
        j.ownerToken, r.revocationKey, i.expiresAt, l.resetAt, w.afterId, p.payload, m.payload
        FROM LocalAdmin a, LocalTemplate t, Subscription s, SubscriptionAutoUpdateState u,
          JobLeaseLock j, RevokedSession r, RuleIndexCache i, AuthRateLimit l,
          SubscriptionCronSweep w, SubscriptionCronProgress p, SubscriptionManualRefreshProgress m LIMIT 0`).all();
      return c.json({ ok: true, database: "ready" });
    } catch {
      return c.json({ ok: false, database: "unavailable" }, 503);
    }
  });
