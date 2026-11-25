// 复用原版字段和凭据校验，按 Worker 的运行期状态切换登录和管理员初始化。
import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { getLocalAdminSetupCredentialError, LOCAL_ADMIN_PASSWORD_MIN_LENGTH } from "@local/lib/admin-credentials";
import { Button } from "@subboost/ui/components/ui/button";
import { FormField } from "@subboost/ui/components/ui/form-field";
import { Input } from "@subboost/ui/components/ui/input";
import { PasswordField } from "@subboost/ui/components/ui/password-field";
import { readJsonResponse } from "@subboost/ui/product/client-response";
import { hasAuthConfigHandoff } from "@subboost/ui/store/config-store/auth-handoff";
import { useWorkerAuthState } from "./auth-state";

function enterAuthenticatedPage() {
  // 与原版一样重新挂载应用，以重新读取 Cookie 并恢复待保存配置。
  window.location.replace(hasAuthConfigHandoff() ? "/" : "/dashboard");
}

/** 显示登录或首次初始化表单，成功后进入已登录页面；请求错误显示在表单内。 */
export default function LoginPage() {
  const auth = useWorkerAuthState();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [setupToken, setSetupToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("setup-token") ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (auth.status === "ready" && auth.authenticated) enterAuthenticatedPage();
  }, [auth]);

  const setupRequired = auth.status === "ready" && auth.setupRequired;
  const setupTokenRequired = setupRequired && auth.setupTokenRequired;
  const canSubmit = !loading && username.trim() && password &&
    (!setupRequired || passwordConfirm) && (!setupTokenRequired || setupToken.trim());

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    const payload = { username, password, passwordConfirm };
    if (setupRequired) {
      const credentialError = getLocalAdminSetupCredentialError(payload);
      if (credentialError) {
        setError(credentialError);
        return;
      }
    }

    setError("");
    setLoading(true);
    try {
      await readJsonResponse(await fetch(setupRequired ? "/api/setup/admin" : "/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(setupTokenRequired ? { "X-SubBoost-Setup-Token": setupToken.trim() } : {}),
        },
        body: JSON.stringify(payload),
      }), setupRequired ? "创建管理员失败" : "登录失败");
      enterAuthenticatedPage();
    } catch (error) {
      setError(error instanceof Error ? error.message : "请求失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center gap-2">
            <Image src="/logo.png" alt="SubBoost" width={64} height={64} className="rounded-2xl shadow-lg shadow-blue-500/25" />
          </Link>
          <h1 className="text-2xl font-bold mt-4 text-fg">欢迎使用 SubBoost</h1>
          <p className="text-fg-50 mt-2">{setupRequired ? "初始化管理员账号" : "登录以使用订阅管理功能"}</p>
        </div>
        <div className="bg-ink/5 backdrop-blur-sm border border-ink/10 rounded-2xl p-6 space-y-4">
          {auth.status === "ready" && !auth.authenticated ? (
            <form onSubmit={handleSubmit} className="space-y-3">
              <FormField label="管理员账号">
                <Input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className="h-12" />
              </FormField>
              <PasswordField
                label="密码"
                autoComplete={setupRequired ? "new-password" : "current-password"}
                description={setupRequired ? `至少 ${LOCAL_ADMIN_PASSWORD_MIN_LENGTH} 个字符` : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-12"
              />
              {setupRequired && (
                <PasswordField
                  label="确认密码"
                  autoComplete="new-password"
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                  className="h-12"
                />
              )}
              {setupTokenRequired && (
                <PasswordField
                  label="初始化令牌"
                  description="请输入此 Worker 配置的 LOCAL_SETUP_TOKEN。"
                  autoComplete="off"
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value)}
                  className="h-12"
                />
              )}
              {error && <p className="text-red-400 text-sm" role="alert">{error}</p>}
              <Button type="submit" disabled={!canSubmit} className="h-12 w-full">
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                {setupRequired ? "创建管理员" : "登录"}
              </Button>
            </form>
          ) : auth.status === "error" || auth.status === "unconfigured" ? (
            <p className="text-amber-400 text-sm" role="alert">{auth.message}</p>
          ) : (
            <div role="status" aria-label="正在读取登录状态" className="h-36 animate-pulse rounded-xl bg-ink/5" />
          )}
        </div>
      </div>
    </div>
  );
}
