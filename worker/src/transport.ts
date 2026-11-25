// 为 Worker 的订阅源与规则抓取提供统一的出站安全边界。
import { createSubscriptionImportErrorInfo, type SubscriptionImportErrorCategory } from "@subboost/core/subscription/import-error";
import {
  importSubscriptionFromUrl,
  type SourceImportRequest,
  type SourceImportResult,
  type SourceImportTransportRequest,
  type SourceImportTransportResult,
} from "@subboost/server-core/subscription/source-import";
import { isPrivateOrReservedIp } from "@subboost/server-core/subscription/ssrf-ip";
import type { WorkerBindings } from "./env";

// 初始请求另计，因此一次抓取最多触发 4 次外部 fetch。
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// #1 的出站硬上限；超时默认沿用共享订阅与规则请求的 15 秒。
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_EXTERNAL_FETCHES = 50;

/** 单次逻辑抓取的出站请求上界，供 Cron 准入计算使用。 */
export const MAX_FETCHES_PER_REQUEST = MAX_REDIRECTS + 1;

/** 外部请求被额度拒绝；调用方应延期，而不是将此计为订阅源失败。 */
export class ExternalFetchBudgetExceededError extends Error {
  constructor() {
    super("本轮外部请求预算已耗尽");
    this.name = "ExternalFetchBudgetExceededError";
  }
}

/**
 * 创建一次 HTTP 或 Cron 调用共享的额度，默认留两个出站子请求的余量。
 * @param limit 本轮允许的实际 fetch 数，必须为 0–50 的整数。
 * @returns 已用、剩余额度及粘性拒绝状态；`throwIfDenied()` 恢复被上层吞掉的额度错误。
 * @throws RangeError 额度不符合 Worker 的硬上限。
 */
export function createExternalFetchBudget(limit = MAX_EXTERNAL_FETCHES - 2) {
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_EXTERNAL_FETCHES) {
    throw new RangeError("外部请求预算必须是 0–50 的整数");
  }
  let used = 0;
  let denied = false;
  return {
    limit,
    get used() { return used; },
    get remaining() { return limit - used; },
    get denied() { return denied; },
    consume() {
      if (used === limit) {
        denied = true;
        throw new ExternalFetchBudgetExceededError();
      }
      used++;
    },
    throwIfDenied() {
      if (denied) throw new ExternalFetchBudgetExceededError();
    },
  };
}

/** 一次 Worker 调用内可由多个受限抓取适配器共享的预算。 */
export type ExternalFetchBudget = ReturnType<typeof createExternalFetchBudget>;

class TransportError extends Error {
  constructor(message: string, readonly category: SubscriptionImportErrorCategory = "network", readonly status?: number) {
    super(message);
  }
}

function validateUrl(input: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw new TransportError("无效的 URL", "format");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TransportError("只支持 HTTP/HTTPS URL", "format");
  }
  if (url.username || url.password) {
    throw new TransportError("URL 不允许包含用户名或密码", "security");
  }
  // 标准 fetch 不能固定解析结果；这里只保证目的地址字面量安全，不模拟 local 的 DNS 固定。
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || isPrivateOrReservedIp(host)) {
    throw new TransportError("禁止访问本机或内网地址", "security");
  }
  return url;
}

function discardBody(response: Response): void {
  // 放弃的流可能永不确认取消，不能让它阻挡重定向或失败返回。
  void response.body?.cancel().catch(() => {});
}

async function fetchFollowingRedirects(upstream: typeof fetch, input: string, init: RequestInit): Promise<Response> {
  let url = validateUrl(input);
  let headers = new Headers(init.headers);
  headers.delete("host");
  for (let followed = 0; ; followed++) {
    init.signal?.throwIfAborted();
    const response = await upstream(url.href, { ...init, headers, redirect: "manual" });
    if (init.signal?.aborted) {
      discardBody(response);
      init.signal.throwIfAborted();
    }
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    if (!location || init.redirect === "manual") return response;
    discardBody(response);
    if (init.redirect === "error") throw new TransportError("不允许重定向");
    if (followed === MAX_REDIRECTS) throw new TransportError("重定向次数过多", "network", 310);
    const next = validateUrl(location, url);
    if (next.origin !== url.origin) {
      // 只保留协商头，避免令牌、Cookie 或自定义凭据跨 origin 泄漏。
      const safe = new Headers();
      for (const key of ["accept", "user-agent", "cache-control"]) {
        const value = headers.get(key);
        if (value !== null) safe.set(key, value);
      }
      headers = safe;
    }
    url = next;
  }
}

async function readBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!response.body) return null;
  if (Number(response.headers.get("content-length")) > maxBytes) {
    discardBody(response);
    throw new TransportError("远程响应过大", "network", 413);
  }
  const reader = response.body.getReader();
  let done = false;
  let canceled = false;
  const cancel = () => {
    if (!done && !canceled) {
      canceled = true;
      void reader.cancel().catch(() => {});
    }
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    let bytes = new Uint8Array(0);
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      const nextSize = size + part.value.byteLength;
      if (nextSize > maxBytes) throw new TransportError("远程响应过大", "network", 413);
      if (nextSize > bytes.length) {
        // 不保留每个分块对象，防止大量小分块耗尽 Isolate 内存。
        const expanded = new Uint8Array(Math.min(maxBytes, Math.max(nextSize, bytes.length * 2)));
        expanded.set(bytes.subarray(0, size));
        bytes = expanded;
      }
      bytes.set(part.value, size);
      size = nextSize;
    }
    done = true;
    return bytes.subarray(0, size);
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

async function withDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal | null,
): Promise<T> {
  callerSignal?.throwIfAborted();
  const timeout = new TransportError("远程请求超时");
  if (!(timeoutMs > 0)) throw timeout;
  const timerController = new AbortController();
  const signal = callerSignal ? AbortSignal.any([timerController.signal, callerSignal]) : timerController.signal;
  const timer = setTimeout(() => timerController.abort(timeout), Math.min(timeoutMs, DEFAULT_TIMEOUT_MS));
  // 与中止信号竞争可约束不尊重 AbortSignal 的上游；中止仍负责取消实际读取。
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([run(signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * 选择当前调用的外部 fetch，供后续的受限传输适配器使用；本函数不发送请求。
 * @param env Worker 绑定，可注入测试传输。
 * @returns 测试传输，或绑定到 Worker 全局对象的标准 fetch。
 */
export function getExternalFetch(env: Pick<WorkerBindings, "fetch">): typeof globalThis.fetch {
  return env.fetch ?? globalThis.fetch.bind(globalThis);
}

/**
 * 为一次 Worker HTTP 或 Cron 调用创建订阅与规则的受限出站传输。
 * @param env 当前调用提供的出站绑定。
 * @param options 带入与其他出站操作共享的预算；省略则创建新预算。
 * @returns 共享预算、订阅文本及导入适配器、规则 fetch 适配器；创建时不请求网络，也不抛错。
 */
export function createExternalTransport(env: Pick<WorkerBindings, "fetch">, options: { budget?: ExternalFetchBudget } = {}) {
  const budget = options.budget ?? createExternalFetchBudget();
  const externalFetch = getExternalFetch(env);
  const upstream: typeof fetch = (url, init) => {
    budget.consume();
    return externalFetch(url, init);
  };
  /**
   * 抓取订阅正文，或为流量信息仅抓取 HEAD。
   * @param request 共享导入器提供的 URL、用途、UA 和下载限制。
   * @returns 正文、响应头，或经过归类的安全／网络失败。
   * @throws ExternalFetchBudgetExceededError 本次调用无法再发出外部请求。
   */
  async function fetchText(request: SourceImportTransportRequest): Promise<SourceImportTransportResult> {
    try {
      return await withDeadline(request.timeoutMs, async (signal) => {
        if (!(request.maxBytes >= 0)) throw new TransportError("无效的响应体大小上限", "format");
        const method = request.purpose === "userinfo" ? "HEAD" : "GET";
        const response = await fetchFollowingRedirects(upstream, request.url, {
          method,
          headers: {
            "User-Agent": request.userAgent,
            Accept: "text/plain, application/yaml, application/x-yaml, */*;q=0.8",
            "Cache-Control": "no-cache",
          },
          signal,
        });
        if (!response.ok || method === "HEAD") discardBody(response);
        if (!response.ok) throw new TransportError(`HTTP ${response.status}`, "network", response.status);
        const bytes = method === "HEAD" ? null : await readBody(response, Math.min(request.maxBytes, MAX_RESPONSE_BYTES), signal);
        return {
          ok: true,
          content: bytes ? new TextDecoder().decode(bytes) : "",
          headers: Object.fromEntries(response.headers),
          responseStatus: response.status,
        };
      });
    } catch (error) {
      if (error instanceof ExternalFetchBudgetExceededError) throw error;
      const failure = error instanceof TransportError ? error : new TransportError("订阅请求失败");
      return {
        ok: false,
        error: failure.message,
        errorInfo: createSubscriptionImportErrorInfo({
          category: failure.category,
          message: failure.message,
          httpStatus: failure.status,
        }),
        responseStatus: failure.status,
      };
    }
  }

  /**
   * 用共享订阅导入器进行 UA 协商和解析；边缘硬限制不受 allowUnsafe 设置影响。
   * @param request 订阅源及可选的补充流量 URL 或 UA。
   * @param importOptions 共享导入器的可选 UA、时间和字节限制。
   * @returns 共享的订阅导入结果。
   * @throws ExternalFetchBudgetExceededError 任意阶段被预算拒绝时，包括共享核心吞掉异常的补充头阶段。
   */
  async function importSubscription(
    request: SourceImportRequest,
    importOptions: Omit<Parameters<typeof importSubscriptionFromUrl>[1], "fetchText"> = {},
  ): Promise<SourceImportResult> {
    budget.throwIfDenied();
    try {
      return await importSubscriptionFromUrl(request, { ...importOptions, fetchText });
    } finally {
      budget.throwIfDenied();
    }
  }

  /**
   * 给规则索引等共享服务注入 GET/HEAD fetch。响应在读取到限制内后才交给调用方。
   * @param input 规则或资源 URL，或包含该 URL 的 Request。
   * @param init 可覆盖请求方法、头部、重定向模式和中止信号；不转发其他运行时选项。
   * @returns 带状态和头部的响应；非成功响应的正文已取消。
   * @throws TransportError 非法请求、超过大小／跳数限制或超时；中止与网络错误原样传播。
   * @throws ExternalFetchBudgetExceededError 本次调用无法再发出外部请求。
   */
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if ((method !== "GET" && method !== "HEAD") || init?.body != null || request?.body != null) {
      throw new TransportError("远程抓取仅支持无正文的 GET 或 HEAD", "format");
    }
    return withDeadline(DEFAULT_TIMEOUT_MS, async (signal) => {
      const response = await fetchFollowingRedirects(upstream, request?.url ?? String(input), {
        method,
        headers: init?.headers ?? request?.headers,
        redirect: init?.redirect ?? request?.redirect,
        signal,
      });
      const read = response.ok && method === "GET";
      if (!read) discardBody(response);
      const bytes = read ? await readBody(response, MAX_RESPONSE_BYTES, signal) : null;
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    }, init?.signal ?? request?.signal);
  };

  return { budget, fetchText, importSubscription, fetch };
}
