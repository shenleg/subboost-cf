// 组装规则搜索、中文候选与识别端点，并在 D1 持久化共享规则目录的索引快照。
import { parsePagePagination } from "@subboost/core/api/pagination";
import { collectCnCandidateParents } from "@subboost/core/rules/cn-candidate-utils";
import { RULE_PROVIDER_CONFIG } from "@subboost/core/rules/metadata";
import {
  buildCnRuleCandidateResponse,
  buildCnRuleCandidateUnavailableResponse,
  buildRuleCatalogDiff,
  createRuleCatalogService,
  normalizeRuleSearchType,
  parseCnRuleCandidateQuery,
  RuleIndexUnavailableError,
  type RemoteRuleIndex,
  type RuleIndexRefreshResult,
} from "@subboost/server-core/rules";
import { handleRuleDetection } from "@subboost/server-core/rules/detect";
import { SUBSCRIPTION_IMPORT_USER_AGENTS } from "@subboost/server-core/subscription/user-agents";
import { Hono } from "hono";
import { nowMs, type WorkerApp, type WorkerBindings } from "../env";
import { createExternalTransport, type ExternalFetchBudget } from "../transport";
import { withCurrentAdmin } from "./auth";

const { owner, repo, ref } = RULE_PROVIDER_CONFIG.github;
const indexKey = `${owner}/${repo}/${ref}`;

// 沿用上游每小时 30 次；单管理员部署只需要一个桶，避免占用 D1 写额度。
const DETECTION_WINDOW_MS = 60 * 60_000;
const DETECTION_LIMIT = 30;
let detectionBucket: { adminId: string; count: number; resetAt: number } | undefined;

function consumeDetectionLimit(adminId: string, now: number): number {
  if (!detectionBucket || detectionBucket.adminId !== adminId || now >= detectionBucket.resetAt) {
    detectionBucket = { adminId, count: 0, resetAt: now + DETECTION_WINDOW_MS };
  }
  if (detectionBucket.count >= DETECTION_LIMIT) return Math.ceil((detectionBucket.resetAt - now) / 1_000);
  detectionBucket.count++;
  return 0;
}

type RuleIndexRow = Omit<RemoteRuleIndex, "geosite" | "geoip"> & { geosite: string; geoip: string };

async function readIndex(db: D1Database): Promise<RemoteRuleIndex | null> {
  const row = await db.prepare(`
    SELECT geosite, geoip, fetchedAt, expiresAt, source FROM RuleIndexCache WHERE key = ?
  `).bind(indexKey).first<RuleIndexRow>();
  return row && { ...row, geosite: JSON.parse(row.geosite), geoip: JSON.parse(row.geoip) };
}

async function fetchAndStoreIndex(env: WorkerBindings, fetch: typeof globalThis.fetch): Promise<RemoteRuleIndex> {
  const catalog = createRuleCatalogService({ fetchImpl: fetch, now: () => nowMs(env) });
  const index = await catalog.getRemoteRuleIndex({ allowStale: false });
  await env.DB.prepare(`
    INSERT INTO RuleIndexCache (key, geosite, geoip, fetchedAt, expiresAt, source) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET geosite = excluded.geosite, geoip = excluded.geoip,
      fetchedAt = excluded.fetchedAt, expiresAt = excluded.expiresAt, source = excluded.source
    WHERE RuleIndexCache.fetchedAt <= excluded.fetchedAt
  `).bind(indexKey, JSON.stringify(index.geosite), JSON.stringify(index.geoip), index.fetchedAt, index.expiresAt, index.source).run();
  return index;
}

type IndexLoadResult =
  | { status: "refreshed" | "skipped"; index: RemoteRuleIndex }
  | { status: "stale"; index: RemoteRuleIndex; error: string }
  | { status: "unavailable"; error: string };

async function resolveIndex(env: WorkerBindings, fetch: typeof globalThis.fetch, force = false): Promise<IndexLoadResult> {
  const cached = await readIndex(env.DB);
  if (!force && cached && cached.expiresAt > nowMs(env)) return { status: "skipped", index: cached };
  try {
    return { status: "refreshed", index: await fetchAndStoreIndex(env, fetch) };
  } catch (error) {
    if (!(error instanceof RuleIndexUnavailableError)) throw error;
    if (cached) return { status: "stale", index: { ...cached, source: "stale" }, error: error.message };
    return { status: "unavailable", error: error.message };
  }
}

async function loadIndex(env: WorkerBindings, fetch: typeof globalThis.fetch): Promise<RemoteRuleIndex> {
  const result = await resolveIndex(env, fetch);
  if (result.status === "unavailable") throw new RuleIndexUnavailableError(result.error);
  return result.index;
}

/**
 * 更新 Cron 和规则查询共用的 D1 索引快照；新鲜时可跳过回源。
 * @param env 当前 Worker 绑定，提供 D1、时钟与外部传输。
 * @param options `force` 强制回源；`budget` 与同一次调用的其他出站请求共享额度。
 * @returns 共享目录的刷新状态与差异；回源失败时带旧快照或返回不可用。
 * @throws 无法读写 D1 快照时抛出。
 */
export async function refreshRuleIndex(
  env: WorkerBindings,
  options: { force?: boolean; budget?: ExternalFetchBudget } = {},
): Promise<RuleIndexRefreshResult> {
  const { fetch } = createExternalTransport(env, { budget: options.budget });
  const result = await resolveIndex(env, fetch, options.force);
  if (result.status === "unavailable") return result;
  return { ...result, diff: buildRuleCatalogDiff(result.index) };
}

function catalogForIndex(index: RemoteRuleIndex, env: WorkerBindings, fetch: typeof globalThis.fetch) {
  return createRuleCatalogService({ fetchImpl: fetch, now: () => nowMs(env), indexForQueries: () => index });
}

/** 挂在 `/api` 下的 `/rules/*` 路由。 */
export const ruleRoutes = new Hono<WorkerApp>().get("/rules/search", async (c) => {
  const { searchParams } = new URL(c.req.url);
  const keyword = searchParams.get("keyword") ?? "";
  const type = normalizeRuleSearchType(searchParams.get("type"));
  const { page, pageSize: size } = parsePagePagination(searchParams, {
    sizeParam: "size", defaultSize: 20, maxPage: 5000, maxSize: 50,
  });
  const query = { keyword, type, page, size };
  const { fetch } = createExternalTransport(c.env);
  try {
    const index = await loadIndex(c.env, fetch);
    return c.json(await catalogForIndex(index, c.env, fetch).searchRules(query));
  } catch (error) {
    if (!(error instanceof RuleIndexUnavailableError)) throw error;
    return c.json({
      items: [], ...query, totalMatched: 0, totalRules: 0, source: "unavailable",
      error: "规则库暂不可用，请稍后重试", code: "RULE_INDEX_UNAVAILABLE",
    }, 503);
  }
}).get("/rules/cn-candidates", async (c) => {
  const { moduleIds, excludedRuleKeys, debug } = parseCnRuleCandidateQuery(new URL(c.req.url).searchParams);
  const query = { moduleIds, excludedRuleKeys };
  const { fetch } = createExternalTransport(c.env);
  try {
    // 全部排除时，上游契约不需要索引，回源故障也应返回空候选。
    const parents = collectCnCandidateParents(moduleIds, { excludedRuleKeys, defaultToAll: true });
    const index = parents.length ? await loadIndex(c.env, fetch) : null;
    const catalog = index
      ? catalogForIndex(index, c.env, fetch)
      : createRuleCatalogService({ fetchImpl: fetch, now: () => nowMs(c.env) });
    const result = await catalog.getCnRuleCandidateDiscovery(query);
    return c.json(buildCnRuleCandidateResponse(result, { debug }));
  } catch (error) {
    if (!(error instanceof RuleIndexUnavailableError)) throw error;
    return c.json(buildCnRuleCandidateUnavailableResponse(), 503);
  }
}).post("/rules/detect", (c) => {
  c.header("Cache-Control", "no-store");
  return withCurrentAdmin(c, (admin) => {
    const retryAfter = consumeDetectionLimit(admin.id, nowMs(c.env));
    if (retryAfter) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "规则识别过于频繁，请稍后重试", code: "RATE_LIMITED" }, 429);
    }
    const { fetch } = createExternalTransport(c.env);
    return handleRuleDetection(c.req.raw, async (url) => {
      const response = await fetch(url, { headers: { "User-Agent": SUBSCRIPTION_IMPORT_USER_AGENTS[0] } });
      return response.ok ? response.text() : null;
    });
  });
});
