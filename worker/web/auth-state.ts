// 适配 Worker 认证接口的运行状态，供首页缺密钥引导和登录初始化共用。
import { useEffect, useState } from "react";

type AuthResponse = {
  authenticated?: boolean;
  setupRequired?: boolean;
  setupTokenRequired?: boolean;
  code?: string;
  message?: string;
  error?: string;
};

type WorkerAuthState =
  | { status: "loading" }
  | { status: "error" | "unconfigured"; message: string }
  | { status: "ready"; authenticated: boolean; setupRequired: boolean; setupTokenRequired: boolean };

/** 读取同源认证状态，返回就绪、缺密钥、请求失败或加载中；错误经状态返回而不抛出。 */
export function useWorkerAuthState(): WorkerAuthState {
  const [state, setState] = useState<WorkerAuthState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const fallback = "无法读取登录状态，请刷新后重试";
    void (async () => {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store", signal: controller.signal });
        const data = (await response.json()) as AuthResponse;
        if (controller.signal.aborted) return;
        if (data.code === "ENCRYPTION_KEY_MISSING") {
          setState({ status: "unconfigured", message: data.message || "请在此 Worker 的「设置 → 变量和机密」中添加 ENCRYPTION_KEY。" });
        } else if (!response.ok || typeof data.authenticated !== "boolean" || typeof data.setupRequired !== "boolean") {
          setState({ status: "error", message: data.error || fallback });
        } else {
          setState({
            status: "ready",
            authenticated: data.authenticated,
            setupRequired: data.setupRequired,
            setupTokenRequired: data.setupTokenRequired === true,
          });
        }
      } catch {
        if (!controller.signal.aborted) setState({ status: "error", message: fallback });
      }
    })();
    return () => controller.abort();
  }, []);

  return state;
}
