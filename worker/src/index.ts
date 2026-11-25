// 组装 Cloudflare Worker 的 HTTP 与原生 Cron 入口。
import { Hono } from "hono";
import type { WorkerApp, WorkerBindings } from "./env";
import { authRoutes } from "./routes/auth";
import { cronRoutes, runScheduled } from "./routes/cron";
import { healthRoutes } from "./routes/health";
import { releaseRoutes } from "./routes/releases";
import { ruleRoutes } from "./routes/rules";
import { subscriptionRoutes } from "./routes/subscriptions";
import { templateRoutes } from "./routes/templates";

const app = new Hono<WorkerApp>()
  .route("/api", healthRoutes)
  .route("/api", authRoutes)
  .route("/api", subscriptionRoutes)
  .route("/api", templateRoutes)
  .route("/api", ruleRoutes)
  .route("/api", releaseRoutes)
  .route("/api", cronRoutes);

/** Cloudflare Module Worker 的标准入口：HTTP 交给 Hono，Cron 交给任务域。 */
export default { fetch: app.fetch, scheduled: runScheduled } satisfies ExportedHandler<WorkerBindings>;
