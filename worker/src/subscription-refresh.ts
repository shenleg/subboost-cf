// 将 Worker 出站传输接到共享订阅刷新核心，供手动刷新和 Cron 共用。
import { generateClashConfig } from "@subboost/core/generator";
import { buildGenerateOptionsFromConfig } from "@subboost/core/subscription/config-utils";
import { SUBSCRIPTION_MAX_PROFILE_REQUESTS } from "@subboost/server-core/subscription/snapshot-comparison";
import { ExternalFetchBudgetExceededError, MAX_FETCHES_PER_REQUEST, type ExternalFetchBudget } from "./transport";
import {
  prepareRefreshCacheSnapshot, refreshNodeSnapshot, SUBSCRIPTION_IMPORT_USER_AGENTS,
  type RefreshNodeSnapshotOptions,
} from "@subboost/server-core/subscription";
import type { SubscriptionSecrets } from "./subscription-store";
import type { createExternalTransport } from "./transport";

/** 原版单订阅的节点数量上限；与 Worker 独立的 D1 字节上限分别判断。 */
export const MAX_NODES_PER_SUBSCRIPTION = 10_000;
// 上游补充流量请求限制；只读取 HEAD，不下载订阅正文。
const USERINFO_TIMEOUT_MS = 8_000;
const USERINFO_MAX_BYTES = 256 * 1024;

/** 可分别装饰或重放的订阅正文和补充流量回调。 */
export type SubscriptionFetchCallbacks = Pick<RefreshNodeSnapshotOptions, "fetchUrlNodes" | "fetchUrlUserInfo">;

/**
 * 用一个调用共享的出站预算构造两种刷新回调，便于 Cron 按回调用途安排和重放。
 * @param transport 本次调用的 Worker 安全传输。
 * @returns 已接入共享导入器的正文回调，以及只读取 HEAD 的流量回调。
 * @throws 回调遇到子请求预算拒绝时传播 ExternalFetchBudgetExceededError；不伪装为订阅源失败。
 */
export function buildSubscriptionFetchCallbacks(transport: ReturnType<typeof createExternalTransport>): Required<SubscriptionFetchCallbacks> {
  return {
    async fetchUrlNodes(source) {
      const imported = await transport.importSubscription({
        url: source.content, userinfoUrl: source.userinfoUrl, userinfoUserAgent: source.userinfoUserAgent,
      });
      if (imported.ok) return { ok: true, nodes: imported.parsedNodes, errors: imported.parseErrors, headers: imported.headers };
      return { ok: false, nodes: [], responseStatus: imported.responseStatus, error: imported.error,
        errorInfo: imported.errorInfo, publicReason: imported.publicReason };
    },
    async fetchUrlUserInfo(source) {
      if (!source.userinfoUrl) return undefined;
      transport.budget.throwIfDenied();
      const result = await transport.fetchText({ url: source.userinfoUrl,
        userAgent: source.userinfoUserAgent?.trim() || SUBSCRIPTION_IMPORT_USER_AGENTS[0],
        purpose: "userinfo", timeoutMs: USERINFO_TIMEOUT_MS, maxBytes: USERINFO_MAX_BYTES });
      return result.ok ? result.headers : undefined;
    },
  };
}

/**
 * 根据冻结快照准备刷新，由调用方决定如何完成和 CAS 提交；本函数不访问 D1。
 * @param secrets 与读取版本配对的解密快照。
 * @param callbacks 可由调度器装饰、缓存或重放的网络回调。
 * @returns 共享快照和不含 YAML 的缓存准备结果，保留部分来源失败与节点超限信号。
 * @throws 回调或 Clash 配置构建抛出的异常原样传播，不会提交刷新结果。
 */
export async function prepareSubscriptionRefresh(secrets: SubscriptionSecrets, callbacks: SubscriptionFetchCallbacks) {
  const snapshot = await refreshNodeSnapshot({ config: secrets.config, urls: secrets.urls, storedNodes: secrets.nodes, ...callbacks });
  const refreshResult = prepareRefreshCacheSnapshot({ config: secrets.config, snapshot, maxNodesPerSubscription: MAX_NODES_PER_SUBSCRIPTION });
  if (refreshResult.ok) {
    // 配置构建仍会校验基础 YAML 和分组监听；仅公开下载需要序列化输出。
    generateClashConfig(buildGenerateOptionsFromConfig(refreshResult.refreshedConfig, {
      nodes: refreshResult.cacheEntry.nodes, proxyProviders: refreshResult.proxyProviders,
    }));
  }
  return { snapshot, refreshResult };
}

type Callbacks = ReturnType<typeof buildSubscriptionFetchCallbacks>;
type NodeResult = Awaited<ReturnType<Callbacks["fetchUrlNodes"]>>;
type InfoResult = Awaited<ReturnType<Callbacks["fetchUrlUserInfo"]>>;
/** 保存已完成回调的结果，以便下一调用重放而无需再次回源。 */
export type RefreshCheckpoint = { nodes: [string, NodeResult][]; userInfo: [string, NonNullable<InfoResult> | null][] };

/**
 * 只在能完成单个回调时开始回源，确保退出预算时拥有可重放的结果。
 * @param checkpoint 当前订阅版本已完成的回调结果。
 * @param live 未完成的回调使用的外部传输适配。
 * @param budget 本次 Worker 调用剩余的外部子请求额度。
 * @param maintainLease 回源前检查或续期本次刷新租约。
 * @returns 计量回调及供调用者持久化进度的接口。
 * @throws 返回的回调在预算或租约失效时抛出，由调用者处理。
 */
export function replaySubscriptionRefreshCallbacks(checkpoint: RefreshCheckpoint, live: Callbacks, budget: ExternalFetchBudget,
  maintainLease: () => Promise<void>) {
  const nodes = new Map(checkpoint.nodes);
  const userInfo = new Map(checkpoint.userInfo);
  const replayed = nodes.size + userInfo.size;
  const callbacks: Callbacks = {
    async fetchUrlNodes(source) {
      const saved = nodes.get(source.id);
      if (saved) return saved;
      await maintainLease();
      // 一次节点回调可能发出全部 UA 请求及一次补充 HEAD，且每个请求可能重定向。
      // 先确认整段能运行，确保打断时只有已完成的结果可重放，不会从同一个请求中途反复重来。
      const supplemental = source.userinfoUrl || source.userinfoUserAgent ? 1 : 0;
      if (budget.remaining < (SUBSCRIPTION_MAX_PROFILE_REQUESTS + supplemental) * MAX_FETCHES_PER_REQUEST) {
        throw new ExternalFetchBudgetExceededError();
      }
      const result = await live.fetchUrlNodes(source);
      budget.throwIfDenied();
      nodes.set(source.id, result);
      return result;
    },
    async fetchUrlUserInfo(source) {
      if (!source.userinfoUrl) return undefined;
      if (userInfo.has(source.id)) return userInfo.get(source.id) ?? undefined;
      await maintainLease();
      if (budget.remaining < MAX_FETCHES_PER_REQUEST) throw new ExternalFetchBudgetExceededError();
      const result = await live.fetchUrlUserInfo(source);
      budget.throwIfDenied();
      userInfo.set(source.id, result ?? null);
      return result;
    },
  };
  return {
    callbacks,
    progressed: () => nodes.size + userInfo.size > replayed,
    checkpoint: () => ({ nodes: [...nodes], userInfo: [...userInfo] } satisfies RefreshCheckpoint),
  };
}
