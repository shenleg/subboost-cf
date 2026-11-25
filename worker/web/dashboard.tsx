// 将原版订阅仪表盘接到 Worker HTTP，透明接续跨预算的手动刷新。
import {
  SubscriptionDashboardSurface,
  type DashboardSurfaceAdapter,
} from "@subboost/ui/dashboard/subscription-dashboard-surface";
import { readJsonResponse } from "@subboost/ui/product/client-response";
import type { RefreshSubscriptionResponse, Subscription, SubscriptionLink } from "@subboost/ui/dashboard/dashboard-types";
import { LOCAL_AUTO_UPDATE_POLICY } from "../../local/src/lib/auto-update-policy";

// 最坏需为多个重定向和 UA 回退分批；单次交互上限防止异常服务无限响应 pending。
const MAX_REFRESH_BATCHES = 64;

function resolveDashboardDownloadUrl(subscription: Subscription): string {
  try {
    const url = new URL(subscription.subscriptionUrl, window.location.href);
    if (url.pathname.includes("/api/subscriptions/")) {
      return `${window.location.origin}${url.pathname}${url.search}`;
    }
  } catch {}
  return subscription.subscriptionUrl;
}

const workerDashboardAdapter: DashboardSurfaceAdapter = {
  loginHref: "/login",
  newSubscriptionHref: "/?newSubscription=1",
  templatesHref: "/templates",
  settingsHref: "/dashboard/settings",
  settingsDescription: "查看本地管理员和运行状态",
  autoUpdateIntervalPolicy: LOCAL_AUTO_UPDATE_POLICY,
  fetchSubscriptions: async () => {
    const response = await fetch("/api/subscriptions");
    const data = await readJsonResponse<{ subscriptions?: Subscription[]; error?: string }>(response, "获取订阅失败");
    return Array.isArray(data.subscriptions) ? data.subscriptions : [];
  },
  deleteSubscription: async (id) => {
    const response = await fetch(`/api/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" });
    await readJsonResponse<{ error?: string }>(response, "删除失败");
  },
  refreshSubscription: async (id) => {
    const path = `/api/subscriptions/${encodeURIComponent(id)}/refresh`;
    let continuation: string | undefined;
    for (let batch = 0; batch < MAX_REFRESH_BATCHES; batch++) {
      const response = await fetch(path, { method: "POST", headers: continuation
        ? { "X-SubBoost-Refresh-Continuation": continuation } : undefined });
      if (response.status !== 202) return readJsonResponse<RefreshSubscriptionResponse>(response, "刷新失败");
      const pending = await readJsonResponse<{ code?: string; continuation?: string }>(response, "刷新失败");
      if (pending.code !== "SUBSCRIPTION_REFRESH_PENDING" || typeof pending.continuation !== "string" ||
          !pending.continuation || pending.continuation === continuation) {
        throw new Error("刷新失败：服务器返回无效的接续状态。");
      }
      continuation = pending.continuation;
    }
    throw new Error("刷新未完成：已达到单次操作的续跑上限，请减少订阅源后重试。");
  },
  updateSubscriptionSettings: async (id, payload) => {
    const response = await fetch(`/api/subscriptions/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await readJsonResponse<{ error?: string }>(response, "保存失败");
  },
  resetSubscriptionLink: async (id, token) => {
    const response = await fetch(`/api/subscriptions/${encodeURIComponent(id)}/reset-link`, {
      method: "POST",
      headers: { "If-Match": `"${token}"` },
    });
    const data = await readJsonResponse<{ subscription: SubscriptionLink }>(response, "重置订阅链接失败");
    return data.subscription;
  },
  resolveDownloadUrl: resolveDashboardDownloadUrl,
};

/** 渲染 Worker 仪表盘；无参数，返回原版界面，不主动抛异常。 */
export default function DashboardPage() {
  return <SubscriptionDashboardSurface adapter={workerDashboardAdapter} />;
}
