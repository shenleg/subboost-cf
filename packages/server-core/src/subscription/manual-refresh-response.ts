// 将刷新快照结果映射为手动刷新 API 的响应。
import type { PreparedRefreshCacheSnapshot } from "./refresh-cache-result";
import type { RefreshNodeSnapshotResult } from "./refresh-node-snapshot";

type ManualRefreshFailureResult = Extract<PreparedRefreshCacheSnapshot, { ok: false }>;

export type ManualRefreshFailureResponse = {
  body: {
    error: string;
    code: "EXTERNAL_FETCH_FAILED" | "NOT_FOUND" | "QUOTA_EXCEEDED";
  };
  status: 502 | 404 | 403;
};

export type ManualRefreshSuccessResponseBody = {
  success: true;
  subscriptionId: string;
  nodeCount: number;
  attemptedUrlFetch: boolean;
  usedUrlFetch: boolean;
  refreshableSourceCount: number;
  refreshedSourceCount: number;
  refreshedUrlSourceCount: number;
  refreshedStaticSourceCount: number;
  failedSourceCount: number;
  updatedAt: string;
};

export function buildManualRefreshFailureResponse(params: {
  refreshResult: ManualRefreshFailureResult;
  maxNodesPerSubscription: number;
}): ManualRefreshFailureResponse {
  if (params.refreshResult.reason === "all_sources_failed") {
    return {
      body: {
        error: "刷新失败：所有导入源均不可用，已保留旧快照。",
        code: "EXTERNAL_FETCH_FAILED",
      },
      status: 502,
    };
  }

  if (params.refreshResult.reason === "empty_result") {
    return {
      body: {
        error: "无可用节点：导入源不可用或解析失败。",
        code: "NOT_FOUND",
      },
      status: 404,
    };
  }

  const maxNodes = params.refreshResult.maxNodesPerSubscription ?? params.maxNodesPerSubscription;
  return {
    body: {
      error: `已超过节点数量上限 (${maxNodes})`,
      code: "QUOTA_EXCEEDED",
    },
    status: 403,
  };
}

/**
 * 将刷新快照的计数和完成时间转换为手动刷新成功响应。
 * @param params 订阅 ID、已提交的刷新结果、来源统计和缓存时间。
 * @returns JSON 响应体，不包含 YAML。
 * @throws 缓存时间不是有效日期时抛出异常。
 */
export function buildManualRefreshSuccessResponseBody(params: {
  subscriptionId: string;
  refreshResult: Extract<PreparedRefreshCacheSnapshot, { ok: true }>;
  snapshot: RefreshNodeSnapshotResult;
  cachedAt: Date;
}): ManualRefreshSuccessResponseBody {
  return {
    success: true,
    subscriptionId: params.subscriptionId,
    nodeCount: params.refreshResult.nodeCount,
    attemptedUrlFetch: params.snapshot.attemptedUrlFetch,
    usedUrlFetch: params.snapshot.usedUrlFetch,
    refreshableSourceCount: params.snapshot.refreshableSourceCount,
    refreshedSourceCount: params.snapshot.refreshedSourceCount,
    refreshedUrlSourceCount: params.snapshot.refreshedUrlSourceCount,
    refreshedStaticSourceCount: params.snapshot.refreshedStaticSourceCount,
    failedSourceCount: params.snapshot.failedSourceCount,
    updatedAt: params.cachedAt.toISOString(),
  };
}
