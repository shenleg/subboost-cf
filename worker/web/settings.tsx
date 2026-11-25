// 展示 Worker 管理员、订阅配额、云端网络边界及同源运行端点。
import { useEffect, useState } from "react";
import { LogOut, Network, ServerCog, ShieldCheck } from "lucide-react";
import { Button } from "@subboost/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@subboost/ui/components/ui/card";
import { useUserStore } from "@subboost/ui/store/user-store";

const healthEndpoints = [
  { label: "存活检查", path: "/api/health/live" },
  { label: "就绪检查", path: "/api/health/ready" },
];

/** 渲染账户设置及运行信息，退出失败在页内显示，不抛出异常。 */
export default function SettingsPage() {
  const { user, fetchUser, logout } = useUserStore();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { void fetchUser(); }, [fetchUser]);

  const handleLogout = async () => {
    setPending(true);
    setError("");
    try {
      await logout();
      // 原版以完整导航清掉已登录页面的配置和内存状态。
      window.location.replace("/login");
    } catch (error) {
      setError(error instanceof Error ? error.message : "退出失败，请重试");
      setPending(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-8">账户设置</h1>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <div className="rounded-lg bg-indigo-500/20 p-2 text-indigo-300"><ShieldCheck className="h-5 w-5" /></div>
            <CardTitle className="text-base">管理员</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-xs text-fg-40">用户名</p>
              <p className="mt-1 font-medium">{user?.username || "未登录"}</p>
            </div>
            <div>
              <p className="text-xs text-fg-40">已保存订阅</p>
              <p className="mt-1 font-medium">{user ? `${user.subscriptionCount} / ${user.quota.maxSubscriptions}` : "-"}</p>
            </div>
            <Button variant="destructive" className="gap-2" onClick={() => void handleLogout()} disabled={!user || pending}>
              <LogOut className="h-4 w-4" /> 退出登录
            </Button>
            {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <div className="rounded-lg bg-emerald-500/20 p-2 text-emerald-300"><Network className="h-5 w-5" /></div>
            <CardTitle className="text-base">订阅源安全</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-fg-60">
            Cloudflare 边缘节点无法访问你设备所在的局域网或本机地址。请使用公网订阅链接，或直接上传订阅文件。
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <div className="rounded-lg bg-sky-500/20 p-2 text-sky-300"><ServerCog className="h-5 w-5" /></div>
            <CardTitle className="text-base">运行端点</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-fg-60">
            {healthEndpoints.map(({ label, path }) => (
              <div key={path}>
                <p className="text-xs text-fg-40">{label}</p>
                <a href={path} className="mt-1 block rounded-md bg-ink/5 px-3 py-2 text-fg-70 hover:underline">
                  <code>{path}</code>
                </a>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
