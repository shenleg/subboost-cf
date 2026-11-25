// 组装订阅管理、公开 YAML、订阅源导入及安全设置端点。
import { decryptEncryptedFieldV2, encryptEncryptedFieldV2 } from "@subboost/server-core/crypto";
import { readJsonBody } from "@subboost/server-core/http";
import { buildSourceImportParseResult } from "@subboost/server-core/subscription/source-import";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createExternalFetchBudget, createExternalTransport, ExternalFetchBudgetExceededError } from "../transport";
import { Hono, type Context } from "hono";
import { generateClashYaml } from "@subboost/core/generator";
import { buildGenerateOptionsFromConfig, getEffectiveTestOptions } from "@subboost/core/subscription/config-utils";
import { buildProxyProvidersFromConfig } from "@subboost/core/subscription/proxy-providers";
import { buildSubscriptionResponseHeaders } from "@subboost/server-core/subscription/response-headers";
import {
  buildManualRefreshFailureResponse, buildManualRefreshSuccessResponseBody,
  createResetSubscriptionAutoUpdateState, normalizeSubscriptionConfigForPersistence,
  normalizeSubscriptionInfoForPersistence, normalizeSubscriptionName, normalizeSubscriptionUrlList,
  serializeSubscriptionDetailData, serializeSubscriptionSummaryData, validateSubscriptionNodeList,
} from "@subboost/server-core/subscription";
import { ENCRYPTION_KEY_MISSING, getClientIp, getEncryptionKey, getSiteOrigin, nowMs, type WorkerApp } from "../env";
import {
  acquireSubscriptionRefreshLease, clearManualRefreshCheckpoint, readRefreshCheckpoint,
  SubscriptionCronLeaseLostError, writeRefreshCheckpoint,
} from "../subscription-cron-store";
import {
  buildSubscriptionFetchCallbacks, MAX_NODES_PER_SUBSCRIPTION, prepareSubscriptionRefresh,
  replaySubscriptionRefreshCallbacks, type RefreshCheckpoint,
} from "../subscription-refresh";
import {
  commitSubscriptionRefresh, insertSubscription, listSubscriptions, readPublicSubscription, readSubscription,
  readSubscriptionSecrets, removeSubscription, rotateSubscriptionToken, saveSubscriptionEdit,
  SUBSCRIPTION_CACHE_TTL_SECONDS, SubscriptionStorageLimitError, type SubscriptionRow, type SubscriptionSecrets,
} from "../subscription-store";
import { withCurrentAdmin } from "./auth";

type RouteContext = Context<WorkerApp>;
// 与原版接口请求限制一致：小型设置/导入与订阅快照使用不同上限。
const SMALL_BODY_LIMIT = 64 * 1024;
const notFound = { error: "Subscription not found.", code: "NOT_FOUND" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function parseBody(c: RouteContext, maxBytes = SMALL_BODY_LIMIT) {
  const body = await readJsonBody(c.req.raw, maxBytes);
  if (body.ok) return body;
  if (body.reason === "too_large") {
    return c.json({ error: "Request body is too large.", code: "PAYLOAD_TOO_LARGE" }, 413);
  }
  return c.json({ error: "Invalid JSON body.", code: "BAD_REQUEST" }, 400);
}

// 兼容上游自托管请求体、节点上限和最短刷新周期。
const SUBSCRIPTION_BODY_LIMIT = 16 * 1024 * 1024;
const MIN_INTERVAL_SECONDS = 360;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// 沿用上游每客户端、每令牌的一分钟限额；限制 Isolate 内存，且免 D1 写入。
const PUBLIC_RATE_WINDOW_MS = 60_000;
const PUBLIC_CLIENT_LIMIT = 600;
const PUBLIC_TOKEN_LIMIT = 120;
const MAX_PUBLIC_RATE_KEYS = 8192;
const publicRate = new Map<string, { count: number; resetAt: number }>();

function consumePublicLimit(key: string, limit: number, now: number) {
  const bucket = publicRate.get(key);
  if (bucket && bucket.resetAt > now) {
    if (bucket.count >= limit) return Math.ceil((bucket.resetAt - now) / 1000);
    bucket.count++;
    return 0;
  }
  publicRate.delete(key);
  if (publicRate.size >= MAX_PUBLIC_RATE_KEYS) {
    const oldest = publicRate.keys().next();
    if (!oldest.done) publicRate.delete(oldest.value);
  }
  publicRate.set(key, { count: 1, resetAt: now + PUBLIC_RATE_WINDOW_MS });
  return 0;
}

async function downloadYaml(c: RouteContext, token: string) {
  c.header("Cache-Control", "no-store");
  const now = nowMs(c.env);
  const validToken = TOKEN_PATTERN.test(token);
  const retryAfter = consumePublicLimit(`client:${getClientIp(c.req.raw)}`, PUBLIC_CLIENT_LIMIT, now) ||
    (validToken ? consumePublicLimit(`token:${token}`, PUBLIC_TOKEN_LIMIT, now) : 0);
  if (retryAfter) {
    c.header("Retry-After", String(retryAfter));
    return c.json({ error: "Too many subscription requests. Try again later.", code: "RATE_LIMITED" }, 429);
  }
  const missing = { ...notFound, error: "Subscription YAML not found." };
  if (!validToken) return c.json(missing, 404);
  const key = getEncryptionKey(c.env);
  if (!key) return c.json({ error: ENCRYPTION_KEY_MISSING.message, code: ENCRYPTION_KEY_MISSING.code }, 503);
  const row = await readPublicSubscription(c.env.DB, token);
  if (!row) return c.json(missing, 404);
  const { config, nodes, subscriptionInfo } = readSubscriptionSecrets(row, key);
  const proxyProviders = buildProxyProvidersFromConfig(config, getEffectiveTestOptions(config));
  if (!nodes.length && !proxyProviders) return c.json(missing, 404);
  const yaml = generateClashYaml(buildGenerateOptionsFromConfig(config, { nodes, proxyProviders }));
  return new Response(yaml, { headers: buildSubscriptionResponseHeaders(row.name, subscriptionInfo, {
    cacheControl: "no-store", cacheExpirySeconds: SUBSCRIPTION_CACHE_TTL_SECONDS,
    autoUpdateIntervalSeconds: row.autoUpdateInterval, isAdmin: true,
  }) });
}

function normalizeInterval(value: unknown) {
  const seconds = typeof value === "string" || typeof value === "number" ? Number(value) : 0;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (!Number.isInteger(seconds)) throw new Error("自动更新间隔必须是整数（秒）");
  if (seconds < MIN_INTERVAL_SECONDS) throw new Error("自动更新最小间隔为 0.1 小时");
  return seconds;
}

function prepareSave(body: Record<string, unknown>, row?: SubscriptionRow, existing?: SubscriptionSecrets) {
  const name = normalizeSubscriptionName(body.name) || row?.name;
  if (!name) throw new Error("Subscription name is required.");
  const urls = "urls" in body ? normalizeSubscriptionUrlList(body.urls) : existing?.urls ?? [];
  const rawNodes = body.nodes;
  if (Array.isArray(rawNodes) && rawNodes.length > MAX_NODES_PER_SUBSCRIPTION) {
    throw new Error(`Node count cannot exceed ${MAX_NODES_PER_SUBSCRIPTION}.`);
  }
  const nodes = "nodes" in body ? validateSubscriptionNodeList(rawNodes ?? []) : existing?.nodes ?? [];
  if (urls.length === 0 && nodes.length === 0) throw new Error("At least one URL or node is required.");
  const hasConfig = !existing || "config" in body || "smartNodeMatchingEnabled" in body;
  const config = hasConfig ? normalizeSubscriptionConfigForPersistence(body, {
    existingConfig: existing?.config,
    idFactory: () => crypto.randomUUID(), splitUrlLines: true, mergeExistingConfig: false,
    defaultSmartNodeMatchingEnabled: true,
  }) : existing.config;
  if (nodes.length && (hasConfig || "nodes" in body || "urls" in body)) {
    const output = buildGenerateOptionsFromConfig(config, { nodes });
    if (!output.nodes.length && !Object.keys(output.proxyProviders ?? {}).length) throw new Error("过滤后没有可用节点");
  }
  const subscriptionInfo = "subscriptionInfo" in body ? normalizeSubscriptionInfoForPersistence(body.subscriptionInfo) ?? {} : existing?.subscriptionInfo ?? {};
  const autoUpdateInterval = "autoUpdateInterval" in body ? normalizeInterval(body.autoUpdateInterval) : row?.autoUpdateInterval ?? null;
  return { name, autoUpdateInterval, secrets: { urls, nodes, config, subscriptionInfo } };
}

function subscriptionUrl(c: RouteContext, token: string) {
  return `${getSiteOrigin(c.req.raw, c.env)}/api/subscriptions/${token}/config.yaml`;
}

function serialize(c: RouteContext, row: SubscriptionRow, key: string, detail = false) {
  c.header("Cache-Control", "no-store");
  const url = subscriptionUrl(c, row.token);
  const options = { subscriptionUrl: url, yamlUrl: url, dateMode: "iso" as const,
    includeCounts: true, includeFailureSourceState: false, includeLastAttemptedAt: true };
  const secrets = readSubscriptionSecrets(row, key);
  return detail ? serializeSubscriptionDetailData(row, secrets, options) : serializeSubscriptionSummaryData(row, secrets, options);
}

type ManualCheckpoint = { continuation: string; checkpoint: RefreshCheckpoint };

async function refreshSubscription(c: RouteContext, ownerId: string, id: string) {
  const env = c.env;
  const key = getEncryptionKey(env)!;
  const requested = c.req.header("X-SubBoost-Refresh-Continuation");
  const conflict = () => c.json({ error: "Subscription changed while refresh was in progress.", code: "SUBSCRIPTION_CHANGED" }, 409);
  // 先验证所有权，避免让不存在的订阅产生租约；获锁后再读取当前版本。
  const exists = await env.DB.prepare("SELECT 1 FROM Subscription WHERE id = ? AND ownerId = ?").bind(id, ownerId).first();
  if (!exists) return c.json(notFound, 404);
  const lease = await acquireSubscriptionRefreshLease(env, `manual-subscription-refresh:${id}`);
  if (!lease) return c.json({ error: "此订阅正在刷新，请稍后重试。", code: "SUBSCRIPTION_REFRESH_IN_PROGRESS" }, 409);
  try {
    const row = await readSubscription(env.DB, ownerId, id);
    if (!row) return c.json(notFound, 404);
    const ciphertext = await readRefreshCheckpoint(env, row, "manual");
    const saved: ManualCheckpoint | null = ciphertext ? JSON.parse(decryptEncryptedFieldV2(ciphertext, key)) : null;
    if (requested !== undefined && (!saved || requested !== saved.continuation)) return conflict();
    // 无令牌的新请求也可接续当前版本，避免上个响应丢失就从头抓取。
    const checkpoint = saved?.checkpoint ?? { nodes: [], userInfo: [] };
    const budget = createExternalFetchBudget();
    const live = buildSubscriptionFetchCallbacks(createExternalTransport(env, { budget }));
    const replay = replaySubscriptionRefreshCallbacks(checkpoint, live, budget, lease.maintain);
    let prepared: Awaited<ReturnType<typeof prepareSubscriptionRefresh>>;
    try {
      prepared = await prepareSubscriptionRefresh(readSubscriptionSecrets(row, key), replay.callbacks);
    } catch (error) {
      if (!(error instanceof ExternalFetchBudgetExceededError)) throw error;
      if (!replay.progressed()) return c.json({ error: error.message, code: "EXTERNAL_FETCH_BUDGET_EXCEEDED" }, 503);
      // 每一段使用新的令牌，旧请求只能在返回冲突后重新开始，不能接管后续阶段。
      const continuation = crypto.randomUUID();
      const next = { continuation, checkpoint: replay.checkpoint() } satisfies ManualCheckpoint;
      const outcome = await writeRefreshCheckpoint(env, lease, row, encryptEncryptedFieldV2(JSON.stringify(next), key), "manual");
      if (outcome === "stale") return conflict();
      if (outcome === "storage_limit") {
        await clearManualRefreshCheckpoint(env, lease, row);
        return storageLimit(c);
      }
      c.header("Cache-Control", "no-store");
      return c.json({ code: "SUBSCRIPTION_REFRESH_PENDING", continuation }, 202);
    }
    const { snapshot, refreshResult } = prepared;
    if (saved) await clearManualRefreshCheckpoint(env, lease, row);
    if (!refreshResult.ok) {
      const failure = buildManualRefreshFailureResponse({ refreshResult, maxNodesPerSubscription: MAX_NODES_PER_SUBSCRIPTION });
      return c.json(failure.body, failure.status);
    }
    await lease.maintain();
    const now = nowMs(env);
    const result = await commitSubscriptionRefresh(env.DB, { row, key, now, lease, cache: refreshResult,
      state: createResetSubscriptionAutoUpdateState() });
    if (result === "storage_limit") return storageLimit(c);
    if (result === "stale") return conflict();
    return c.json(buildManualRefreshSuccessResponseBody({ subscriptionId: row.id, refreshResult, snapshot, cachedAt: new Date(now) }));
  } catch (error) {
    if (error instanceof SubscriptionCronLeaseLostError) return conflict();
    throw error;
  } finally {
    // 释放失败由 TTL 接管，旧请求不能释放新的持有者。
    await lease.release().catch(() => undefined);
  }
}

function changed(c: RouteContext) {
  return c.json({ error: "Subscription changed while the operation was in progress.", code: "SUBSCRIPTION_CHANGED" }, 409);
}

function storageLimit(c: RouteContext) {
  return c.json({ error: new SubscriptionStorageLimitError().message, code: "SUBSCRIPTION_STORAGE_LIMIT" }, 413);
}

async function saveFromRequest(c: RouteContext, ownerId: string, row?: SubscriptionRow) {
  const parsed = await parseBody(c, SUBSCRIPTION_BODY_LIMIT);
  if (parsed instanceof Response) return parsed;
  if (!isRecord(parsed.value)) return c.json({ error: "Invalid JSON body.", code: "BAD_REQUEST" }, 400);
  const key = getEncryptionKey(c.env)!; // 所有管理路由已通过 withCurrentAdmin 的密钥检查。
  const existing = row && readSubscriptionSecrets(row, key);
  let fields: ReturnType<typeof prepareSave>;
  try {
    fields = prepareSave(parsed.value, row, existing);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid subscription.", code: "BAD_REQUEST" }, 400);
  }
  const input = { ...fields, key, now: nowMs(c.env) };
  try {
    if (!row) {
      const created = await insertSubscription(c.env.DB, { ...input, ownerId });
      return c.json({ subscription: serialize(c, created, key) }, 201);
    }
    const state = row.autoUpdateInterval === null && fields.autoUpdateInterval !== null ? createResetSubscriptionAutoUpdateState() : undefined;
    const edited = await saveSubscriptionEdit(c.env.DB, row, { ...input, state });
    return edited ? c.json({ subscription: serialize(c, edited, key) }) : changed(c);
  } catch (error) {
    if (!(error instanceof SubscriptionStorageLimitError)) throw error;
    return storageLimit(c);
  }
}

/** 挂在 `/api` 下；覆盖 `/subscriptions`、`/source-import` 和 `/settings/source-import`。 */
export const subscriptionRoutes = new Hono<WorkerApp>()
  .get("/settings/source-import", (c) => withCurrentAdmin(c, async (admin) => {
    const row = await c.env.DB.prepare("SELECT allowUnsafeSubscriptionSources FROM LocalAdmin WHERE id = ?")
      .bind(admin.id).first<{ allowUnsafeSubscriptionSources: number }>();
    if (!row) return c.json({ ...notFound, error: "Local admin not found." }, 404);
    return c.json({ allowUnsafeSubscriptionSources: row.allowUnsafeSubscriptionSources === 1 });
  }))
  .patch("/settings/source-import", (c) => withCurrentAdmin(c, async (admin) => {
    const parsed = await parseBody(c);
    if (parsed instanceof Response) return parsed;
    const value = isRecord(parsed.value) ? parsed.value.allowUnsafeSubscriptionSources : undefined;
    if (typeof value !== "boolean") {
      return c.json({ error: "allowUnsafeSubscriptionSources must be a boolean.", code: "VALIDATION_ERROR" }, 400);
    }
    const result = await c.env.DB.prepare("UPDATE LocalAdmin SET allowUnsafeSubscriptionSources = ? WHERE id = ?")
      .bind(Number(value), admin.id).run();
    if (!result.meta.changes) return c.json({ ...notFound, error: "Local admin not found." }, 404);
    return c.json({ allowUnsafeSubscriptionSources: value });
  }))
  .post("/source-import", (c) => withCurrentAdmin(c, async () => {
    const parsed = await parseBody(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed.value;
    if (!isRecord(body)) return c.json({ error: "Invalid JSON body.", code: "BAD_REQUEST" }, 400);
    const field = (key: string) => typeof body[key] === "string" ? body[key].trim() : "";
    try {
      const result = await createExternalTransport(c.env).importSubscription({
        url: field("url"),
        userinfoUrl: field("userinfoUrl") || undefined,
        userinfoUserAgent: field("userinfoUserAgent") || undefined,
      });
      if (!result.ok) {
        const status = result.responseStatus;
        return c.json({
          error: result.error,
          code: result.errorInfo.category === "format" ? "BAD_REQUEST" : "INTERNAL_ERROR",
          errorInfo: result.errorInfo,
        }, status && status >= 400 ? status as ContentfulStatusCode : 400);
      }
      return c.json({ content: result.content, headers: result.headers, parseResult: buildSourceImportParseResult(result) });
    } catch (error) {
      if (!(error instanceof ExternalFetchBudgetExceededError)) throw error;
      return c.json({ error: error.message, code: "EXTERNAL_FETCH_BUDGET_EXCEEDED" }, 503);
    }
  }))
  .get("/subscriptions", (c) => withCurrentAdmin(c, async (admin) => {
    const key = getEncryptionKey(c.env)!;
    const rows = await listSubscriptions(c.env.DB, admin.id);
    c.header("Cache-Control", "no-store");
    return c.json({ subscriptions: rows.map((row) => serialize(c, row, key)) });
  }))
  .post("/subscriptions", (c) => withCurrentAdmin(c, (admin) => saveFromRequest(c, admin.id)))
  .get("/subscriptions/:token/config.yaml", (c) => downloadYaml(c, c.req.param("token")))
  .get("/subscriptions/:id", (c) => withCurrentAdmin(c, async (admin) => {
    const row = await readSubscription(c.env.DB, admin.id, c.req.param("id"));
    return row ? c.json({ subscription: serialize(c, row, getEncryptionKey(c.env)!, true) }) : c.json(notFound, 404);
  }))
  .put("/subscriptions/:id", (c) => withCurrentAdmin(c, async (admin) => {
    const row = await readSubscription(c.env.DB, admin.id, c.req.param("id"));
    return row ? saveFromRequest(c, admin.id, row) : c.json(notFound, 404);
  }))
  .post("/subscriptions/:id/refresh", (c) => withCurrentAdmin(c, (admin) => refreshSubscription(c, admin.id, c.req.param("id"))))
  .post("/subscriptions/:id/reset-link", (c) => withCurrentAdmin(c, async (admin) => {
    const id = c.req.param("id");
    // If-Match 只接受一个带引号的旧令牌，不接受通配符或弱 ETag。
    const expectedToken = /^"([A-Za-z0-9_-]{43})"$/.exec(c.req.header("If-Match") ?? "")?.[1];
    if (!id || id.length > 128 || !expectedToken) return c.json({ error: "请刷新页面后重试", code: "BAD_REQUEST" }, 400);
    const result = await rotateSubscriptionToken(c.env.DB, { id, ownerId: admin.id, expectedToken, now: nowMs(c.env) });
    if (result.kind !== "rotated") {
      return result.kind === "not_found"
        ? c.json({ error: "订阅不存在", code: "NOT_FOUND" }, 404)
        : c.json({ error: "订阅链接已更改，请刷新页面后重试", code: "CONFLICT" }, 409);
    }
    c.header("Cache-Control", "no-store");
    return c.json({ subscription: { ...result.subscription, subscriptionUrl: subscriptionUrl(c, result.subscription.token) } });
  }))
  .delete("/subscriptions/:id", (c) => withCurrentAdmin(c, async (admin) => {
    const deleted = await removeSubscription(c.env.DB, admin.id, c.req.param("id"));
    return deleted ? c.json({ success: true }) : c.json(notFound, 404);
  }));
