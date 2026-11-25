// 组装原生 Cron 和可选的 HTTP 手动触发端点。
import { validateCronSecret } from "@subboost/server-core/cron-auth";
import { SUBSCRIPTION_MAX_PROFILE_REQUESTS } from "@subboost/server-core/subscription/snapshot-comparison";
import { Hono } from "hono";
import { ENCRYPTION_KEY_MISSING, getEncryptionKey, type WorkerApp, type WorkerBindings } from "../env";
import { runSubscriptionCron } from "../subscription-cron";
import { SubscriptionCronLeaseLostError } from "../subscription-cron-store";
import { createExternalFetchBudget, MAX_FETCHES_PER_REQUEST } from "../transport";
import { refreshRuleIndex } from "./rules";

// 此预算只计外部 fetch，D1 查询另行限制。
const CRON_EXTERNAL_FETCH_LIMIT = 50;
// 空轮必须放得下一个最坏情况的回调（全部 UA + 流量 HEAD，每次至多三跳）。
const MIN_CRON_FETCH_LIMIT = (SUBSCRIPTION_MAX_PROFILE_REQUESTS + 1) * MAX_FETCHES_PER_REQUEST;

function cronBudget(env: WorkerBindings) {
  const limit = Number(env.CRON_FETCH_LIMIT);
  return createExternalFetchBudget(Number.isSafeInteger(limit) && limit >= MIN_CRON_FETCH_LIMIT
    ? Math.min(limit, CRON_EXTERNAL_FETCH_LIMIT) : CRON_EXTERNAL_FETCH_LIMIT);
}
const RULE_INDEX_CRON = "0 */6 * * *";
const SUBSCRIPTION_CRON = "*/6 * * * *";

/** 挂在 `/api` 下的 `/cron/*` 路由，与原生触发复用任务实现。 */
export const cronRoutes = new Hono<WorkerApp>()
  .use("/cron/*", async (c, next) => {
    const auth = validateCronSecret({ cronSecret: c.env.CRON_SECRET?.trim() ?? "", authorization: c.req.header("Authorization") });
    if (auth.ok) return next();
    if (auth.reason === "missing-secret") return c.json({ error: "CRON_SECRET not configured.", code: "CONFIGURATION_ERROR" }, 503);
    return c.json({ error: "Invalid cron secret.", code: "UNAUTHORIZED" }, 401);
  })
  .post("/cron/update-subscriptions", async (c) => {
    const key = getEncryptionKey(c.env);
    if (!key) return c.json({ error: ENCRYPTION_KEY_MISSING.message, code: ENCRYPTION_KEY_MISSING.code }, 503);
    try {
      return c.json(await runSubscriptionCron(c.env, key, cronBudget(c.env)));
    } catch (error) {
      if (!(error instanceof SubscriptionCronLeaseLostError)) throw error;
      return c.json({ error: error.message, code: "JOB_LEASE_LOST" }, 503);
    }
  })
  .post("/cron/update-rule-index", async (c) => {
    const result = await runRuleIndex(c.env, c.req.query("force") === "1");
    if (result.status === "unavailable") {
      return c.json({ success: false, status: result.status, error: result.error, code: "RULE_INDEX_UNAVAILABLE" }, 503);
    }
    const { status, index: { source, fetchedAt, expiresAt }, diff, error } = result;
    return c.json({ success: true, status, source, fetchedAt, expiresAt, diff, ...(error ? { error } : {}) });
  });

function runRuleIndex(env: WorkerBindings, force = false) {
  return refreshRuleIndex(env, { force, budget: cronBudget(env) });
}

/**
 * 根据配置的表达式派发原生 Cron；无需 HTTP 密钥。
 * @param controller Cloudflare 告知的触发表达式。
 * @param env 本次运行的 D1 与传输绑定。
 * @param ctx 用于等待任务完成的执行上下文。
 * @returns 无返回值；已知表达式向 `waitUntil` 注册任务，未知表达式直接结束。
 * @throws 不主动同步抛异常；任务失败会拒绝传入 `waitUntil` 的 Promise。
 */
export const runScheduled: ExportedHandlerScheduledHandler<WorkerBindings> = (controller, env, ctx) => {
  // 规则缓存有效期长于 Cron 周期，定时触发需主动更新，HTTP 默认仍尊重缓存。
  if (controller.cron === RULE_INDEX_CRON) ctx.waitUntil(runRuleIndex(env, true).then((result) => {
    if (result.status === "unavailable") throw new Error(result.error);
  }));
  if (controller.cron === SUBSCRIPTION_CRON) ctx.waitUntil(Promise.resolve().then(() => {
    const key = getEncryptionKey(env);
    if (!key) throw new Error(ENCRYPTION_KEY_MISSING.message);
    return runSubscriptionCron(env, key, cronBudget(env));
  }));
};
