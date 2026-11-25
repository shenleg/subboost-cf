// 将订阅源刷新结果准备为可持久化的快照，并按需生成 Clash YAML。
import { generateClashYaml } from "@subboost/core/generator";
import {
  buildGenerateOptionsFromConfig,
  getEffectiveTestOptions,
} from "@subboost/core/subscription/config-utils";
import { buildProxyProvidersFromConfig } from "@subboost/core/subscription/proxy-providers";
import { resolveNodeNameFilter } from "@subboost/core/subscription/node-name-filter";
import { reconcileNodeNameReferences } from "@subboost/core/subscription/node-name-references";
import type { ParsedNode } from "@subboost/core/types/node";
import type { SubscriptionResponseInfo } from "@subboost/core/subscription/subscription-response-info";
import type { RefreshNodeSnapshotResult } from "./refresh-node-snapshot";

export type RefreshCacheFailureReason =
  | "all_sources_failed"
  | "empty_result"
  | "node_quota_exceeded";

type RefreshCacheSnapshotEntry = {
  nodes: ParsedNode[];
  subscriptionInfo: SubscriptionResponseInfo;
};

export type RefreshCacheEntry = RefreshCacheSnapshotEntry & { generatedYaml: string };

type RefreshCacheSnapshotSuccess = {
  ok: true;
  cacheEntry: RefreshCacheSnapshotEntry;
  refreshedConfig: Record<string, unknown>;
  nodeCount: number;
  proxyProviders?: Record<string, unknown>;
};

type RefreshCacheFailure = {
  ok: false;
  reason: RefreshCacheFailureReason;
  proxyProviders?: Record<string, unknown>;
  nodeCount: number;
  maxNodesPerSubscription?: number;
};

export type PreparedRefreshCacheSnapshot = RefreshCacheSnapshotSuccess | RefreshCacheFailure;

export type PreparedRefreshCacheResult =
  | (RefreshCacheSnapshotSuccess & { cacheEntry: RefreshCacheEntry; generatedYaml: string })
  | RefreshCacheFailure;

type RefreshCachePreparationInput = {
  config: Record<string, unknown>;
  snapshot: RefreshNodeSnapshotResult;
  maxNodesPerSubscription: number;
  proxyProviders?: Record<string, unknown>;
};

/**
 * 检查刷新结果并准备可持久化的快照，不构建 Clash 配置或 YAML。
 * @param params 原配置、刷新快照、节点配额及可选的 provider 覆盖值。
 * @returns 持久化所需的节点、流量和刷新后配置，或可识别的刷新失败。
 * @throws 配置准备中的异常原样传播；常规刷新失败通过返回值表达。
 */
export function prepareRefreshCacheSnapshot(params: RefreshCachePreparationInput): PreparedRefreshCacheSnapshot {
  const { testUrl, testInterval } = getEffectiveTestOptions(params.config);
  const proxyProviders =
    params.proxyProviders ??
    buildProxyProvidersFromConfig(params.config, {
      testUrl,
      testInterval,
    });
  const hasProxyProviders = Boolean(
    proxyProviders && Object.keys(proxyProviders).length > 0
  );
  const common = {
    proxyProviders,
    nodeCount: params.snapshot.nodes.length,
  };
  const nodeNameFilterResult = resolveNodeNameFilter(
    params.snapshot.nodes,
    params.config.nodeNameFilter
  );

  if (params.snapshot.refreshableSourceCount > 0 && params.snapshot.refreshedSourceCount === 0) {
    return {
      ok: false,
      reason: "all_sources_failed",
      ...common,
    };
  }

  if (params.snapshot.nodes.length > params.maxNodesPerSubscription) {
    return {
      ok: false,
      reason: "node_quota_exceeded",
      maxNodesPerSubscription: params.maxNodesPerSubscription,
      ...common,
    };
  }

  if (nodeNameFilterResult.effectiveCount === 0 && !hasProxyProviders) {
    return {
      ok: false,
      reason: "empty_result",
      ...common,
    };
  }

  const refreshedConfig = reconcileNodeNameReferences(
    {
      ...params.config,
      sources: params.snapshot.savedSources,
    },
    {
      nodes: params.snapshot.nodes,
      renameMap: params.snapshot.renameMap,
    }
  );

  return {
    ok: true,
    ...common,
    refreshedConfig,
    cacheEntry: {
      nodes: params.snapshot.nodes,
      subscriptionInfo: params.snapshot.subscriptionInfo,
    },
  };
}

/**
 * 准备刷新快照并生成 Clash YAML，保留旧缓存接口。
 * @param params 原配置、刷新快照、节点配额及可选的 provider 覆盖值。
 * @returns 刷新失败，或包含 YAML 的刷新快照。
 * @throws 快照准备或 Clash 配置生成中的异常原样传播。
 */
export function prepareRefreshCacheResult(params: RefreshCachePreparationInput): PreparedRefreshCacheResult {
  const prepared = prepareRefreshCacheSnapshot(params);
  if (!prepared.ok) return prepared;

  const { cacheEntry, ...result } = prepared;
  const generatedYaml = generateClashYaml(
    buildGenerateOptionsFromConfig(result.refreshedConfig, {
      nodes: cacheEntry.nodes,
      proxyProviders: result.proxyProviders,
    })
  );
  return { ...result, generatedYaml, cacheEntry: { ...cacheEntry, generatedYaml } };
}
