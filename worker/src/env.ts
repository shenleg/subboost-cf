// 定义 Worker 绑定及 HTTP/Cron 共用的运行时接缝。

/** Cloudflare 注入 DB 和字符串配置；函数接缝只由直接调用入口的测试提供。 */
export type WorkerBindings = {
  DB: D1Database;
  ENCRYPTION_KEY?: string;
  JWT_SECRET?: string;
  LOCAL_SETUP_TOKEN?: string;
  APP_URL?: string;
  CRON_SECRET?: string;
  /** 每次订阅 Cron 可处理的条数，默认 3，最多 5，以限制单次 D1 查询数。 */
  CRON_BATCH_SIZE?: string;
  /** 每次 Cron 的实际外部请求数，接受 20–50，默认 50。 */
  CRON_FETCH_LIMIT?: string;
  RELEASE_REPO?: string;
  /** 可控时钟返回 Unix 毫秒。 */
  now?: () => number;
  /** 仅替代出站 HTTP，不影响 Hono 接收请求。 */
  fetch?: typeof globalThis.fetch;
};

/** HTTP 路由共享的 Hono 环境类型。 */
export type WorkerApp = { Bindings: WorkerBindings };

/** 就绪检查、认证与初始化可共用的必填密钥配置指引。 */
export const ENCRYPTION_KEY_MISSING = {
  code: "ENCRYPTION_KEY_MISSING",
  message: "请在 Cloudflare Dashboard 的 Workers 和 Pages 中选择此 Worker，打开「设置 → 变量和机密」，添加 ENCRYPTION_KEY。",
} as const;

/**
 * 读取去掉首尾空白的加密密钥，与原版密钥读取方式一致。
 * @param env 当前 Worker 绑定。
 * @returns 配置的密钥；缺失或全空白时返回 `undefined`。
 */
export function getEncryptionKey(env: WorkerBindings): string | undefined {
  return env.ENCRYPTION_KEY?.trim() || undefined;
}

/**
 * 读取当前逻辑时间，供 HTTP 与 Cron 使用同一可控时钟。
 * @param env Worker 绑定，可注入测试时钟。
 * @returns Unix 毫秒。
 */
export function nowMs(env: WorkerBindings): number {
  return env.now?.() ?? Date.now();
}

/**
 * 获取 Cookie 和公开链接共用的站点根地址；不信任 Origin 或转发请求头。
 * @param request Cloudflare Worker 收到的请求。
 * @param env Worker 绑定；合法 HTTP(S) `APP_URL` 优先。
 * @returns 不带尾斜杠的 HTTP(S) origin；无效配置回退到请求 URL。
 */
export function getSiteOrigin(request: Request, env: WorkerBindings): string {
  const configured = env.APP_URL && URL.parse(env.APP_URL);
  if (configured && (configured.protocol === "https:" || configured.protocol === "http:") &&
    !configured.username && !configured.password) return configured.origin;
  return new URL(request.url).origin;
}

/**
 * 获取限流使用的客户端 IP，只使用 Cloudflare 提供的单一地址。
 * @param request Cloudflare Worker 收到的请求。
 * @returns 平台地址；缺失时使用同一个本地桶，不接受可伪造的转发链。
 */
export function getClientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP")?.trim() || "127.0.0.1";
}
