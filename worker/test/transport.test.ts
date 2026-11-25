// 从 Worker 公共传输入口验证订阅与规则外部请求契约，不挂载测试专用路由。
import { expect, test, vi } from "vitest";
import { createExternalFetchBudget, createExternalTransport, ExternalFetchBudgetExceededError } from "../src/transport";

/** 验证传输交付上游正文和流量头，且使用标准 GET。 */
test("从注入的上游读取订阅正文和响应头", async () => {
  const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response("节点订阅", {
    headers: { "Subscription-Userinfo": "upload=12" },
  }));
  const transport = createExternalTransport({ fetch: upstream });

  await expect(transport.fetchText({
    url: "https://source.example/sub", purpose: "content", userAgent: "Clash", timeoutMs: 1_000, maxBytes: 1024,
  })).resolves.toMatchObject({ ok: true, content: "节点订阅", headers: { "subscription-userinfo": "upload=12" } });
  expect(upstream).toHaveBeenCalledWith("https://source.example/sub", expect.objectContaining({
    method: "GET", redirect: "manual", headers: expect.any(Headers),
  }));
  expect(new Headers(upstream.mock.calls[0][1]?.headers).get("user-agent")).toBe("Clash");
});

/** 创建抓取订阅正文的请求；参数是目标 URL，返回固定 UA 和限制的请求，不抛错。 */
function sourceRequest(url = "https://source.example/sub") {
  return { url, purpose: "content" as const, userAgent: "Clash", timeoutMs: 1_000, maxBytes: 10 * 1024 * 1024 };
}

/** 首跳与跳转目标使用相同限制，非法目的地不能发起网络请求。 */
test.each([
  "ftp://source.example/sub",
  "https://user:secret@source.example/sub",
  "http://127.0.0.1/sub",
  "http://10.0.0.1/sub",
  "http://[::1]/sub",
  "http://localhost./sub",
])("拦截首跳和重定向中的受限地址 %s", async (blockedUrl) => {
  const upstream = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, {
    status: 302, headers: { location: blockedUrl },
  }));
  const { fetchText } = createExternalTransport({ fetch: upstream });

  await expect(fetchText(sourceRequest(blockedUrl))).resolves.toMatchObject({ ok: false });
  expect(upstream).not.toHaveBeenCalled();
  await expect(fetchText(sourceRequest())).resolves.toMatchObject({ ok: false });
  expect(upstream).toHaveBeenCalledTimes(1);
});

/** 重定向跟随有硬上限，所有弃用的正文流都应取消。 */
test("跟随三个相对重定向，但取消响应体且不发出第四跳", async () => {
  const cancel = vi.fn();
  const upstream = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream({ cancel }), {
    status: 302, headers: { location: `./hop-${upstream.mock.calls.length}` },
  }));
  const { fetchText } = createExternalTransport({ fetch: upstream });

  await expect(fetchText(sourceRequest())).resolves.toMatchObject({ ok: false, responseStatus: 310 });
  expect(upstream.mock.calls.map(([url]) => url)).toEqual([
    "https://source.example/sub", "https://source.example/hop-1", "https://source.example/hop-2", "https://source.example/hop-3",
  ]);
  expect(cancel).toHaveBeenCalledTimes(4);
});

/** 上游可能缺报或少报 Content-Length；实际读取仍以字节为准。 */
test.each([undefined, "1", "10485761"])("响应超过 10 MiB 时停止并取消流（Content-Length: %s）", async (length) => {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const chunk = new Uint8Array(1024 * 1024);
  let chunks = 0;
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (chunks++ < 12) controller.enqueue(chunk);
    else controller.close();
  });
  const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ pull, cancel }), {
    headers: length ? { "Content-Length": length } : {},
  }));
  const { fetchText } = createExternalTransport({ fetch: upstream });

  await expect(fetchText({ ...sourceRequest(), maxBytes: 32 * 1024 * 1024 })).resolves.toMatchObject({
    ok: false, responseStatus: 413,
  });
  expect(cancel).toHaveBeenCalledOnce();
});

/** 已收到响应头也不能让正文读取绕过时限。 */
test("到达超时时取消已收到但卡住的响应体", async () => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const { fetchText } = createExternalTransport({ fetch: upstream });

    const result = fetchText({ ...sourceRequest(), timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    await expect(result).resolves.toMatchObject({ ok: false, error: expect.stringContaining("超时") });
    expect(upstream.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

/** 预算拒绝跨传输持久有效，防止不同调用方重复支出。 */
test("按实际 fetch 计量跳转与失败，拒绝状态跨传输保持粘性", async () => {
  const budget = createExternalFetchBudget(2);
  const upstream = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/next" } }))
    .mockRejectedValueOnce(new TypeError("network failed"));
  const { fetchText } = createExternalTransport({ fetch: upstream }, { budget });

  await expect(fetchText(sourceRequest("http://127.0.0.1/sub"))).resolves.toMatchObject({ ok: false });
  expect(budget.remaining).toBe(2);
  await expect(fetchText(sourceRequest())).resolves.toMatchObject({ ok: false });
  expect(budget).toMatchObject({ used: 2, remaining: 0, denied: false });

  const second = createExternalTransport({ fetch: upstream }, { budget });
  await expect(second.fetchText(sourceRequest())).rejects.toBeInstanceOf(ExternalFetchBudgetExceededError);
  expect(budget).toMatchObject({ used: 2, remaining: 0, denied: true });
  expect(() => budget.throwIfDenied()).toThrow(ExternalFetchBudgetExceededError);
  expect(upstream).toHaveBeenCalledTimes(2);
  expect(() => createExternalFetchBudget(51)).toThrow(RangeError);
});

const SUBSCRIPTION_YAML = "proxies:\n  - {name: usable, type: ss, server: node.example, port: 443, cipher: aes-128-gcm, password: example}\n";

/** 第一个 UA 被拒，第二个 UA 提供节点；补充请求只读 HEAD 头部。 */
test("保留共享 UA 回退、解析与补充流量信息", async () => {
  const upstream = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("blocked", { status: 403 }))
    .mockResolvedValueOnce(new Response(SUBSCRIPTION_YAML))
    .mockResolvedValueOnce(new Response(null, { headers: { "Subscription-Userinfo": "upload=12" } }));
  const transport = createExternalTransport({ fetch: upstream });

  await expect(transport.importSubscription({
    url: "https://source.example/sub", userinfoUrl: "https://info.example/usage", userinfoUserAgent: "Usage-UA",
  }, { userAgents: ["Initial-UA", "Fallback-UA"] })).resolves.toMatchObject({
    ok: true, parsedNodes: [{ name: "usable" }], headers: { "subscription-userinfo": "upload=12" },
  });
  expect(upstream.mock.calls.map(([url, init]) => [url, init?.method, new Headers(init?.headers).get("user-agent")])).toEqual([
    ["https://source.example/sub", "GET", "Initial-UA"],
    ["https://source.example/sub", "GET", "Fallback-UA"],
    ["https://info.example/usage", "HEAD", "Usage-UA"],
  ]);
  expect(transport.budget).toMatchObject({ used: 3, denied: false });
});

/** 共享导入吞掉候选 UA 和补充头的传输异常，Worker 调用者仍应得到可延期的错误。 */
test.each([403, 200])("共享导入不把预算拒绝当作来源结果（首个 HTTP 状态 %s）", async (status) => {
  const upstream = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(SUBSCRIPTION_YAML, { status }));
  const budget = createExternalFetchBudget(1);
  const { importSubscription } = createExternalTransport({ fetch: upstream }, { budget });

  await expect(importSubscription({ url: "https://source.example/sub", userinfoUserAgent: "Usage-UA" }, {
    userAgents: status === 200 ? ["First-UA"] : ["First-UA", "Second-UA"],
  })).rejects.toBeInstanceOf(ExternalFetchBudgetExceededError);
  expect(upstream).toHaveBeenCalledOnce();
  expect(budget.denied).toBe(true);
});

/** 规则索引可以注入标准 fetch 签名；跨 origin 不能把索引用的令牌转发给下载站。 */
test("规则 fetch 共享预算，并在跨站跳转中保留 Accept 而移除凭据", async () => {
  const upstream = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.redirect("https://download.example/rules", 302))
    .mockResolvedValueOnce(Response.json({ tree: [] }, { headers: { etag: '"old"' } }));
  const transport = createExternalTransport({ fetch: upstream });
  const response = await transport.fetch(new Request("https://rules.example/catalog", {
    headers: { Accept: "application/json", Authorization: "Bearer private", Cookie: "session=private" },
  }));

  await expect(response.json()).resolves.toEqual({ tree: [] });
  expect(response.headers.get("etag")).toBe('"old"');
  expect(upstream.mock.calls.map(([, init]) => init?.redirect)).toEqual(["manual", "manual"]);
  const initial = new Headers(upstream.mock.calls[0][1]?.headers);
  const redirected = new Headers(upstream.mock.calls[1][1]?.headers);
  expect(initial.get("authorization")).toBe("Bearer private");
  expect(redirected.get("authorization")).toBeNull();
  expect(redirected.get("cookie")).toBeNull();
  expect(redirected.get("accept")).toBe("application/json");
  expect(transport.budget.used).toBe(2);
});

/** 规则下载应能按调用方信号取消读取。 */
test("规则 fetch 响应体读取可由调用方信号提前中止", async () => {
  const abort = new AbortController();
  const cancel = vi.fn();
  const reading = Promise.withResolvers<void>();
  const body = new ReadableStream({ pull: () => reading.resolve(), cancel }, { highWaterMark: 0 });
  const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
  const { fetch: fetchRules } = createExternalTransport({ fetch: upstream });
  const pending = fetchRules("https://rules.example/list", { signal: abort.signal });
  const rejection = expect(pending).rejects.toThrow("停止规则抓取");
  // 等上游第一次被主动读取，确保覆盖响应体阶段而非响应头阶段。
  await reading.promise;
  abort.abort(new Error("停止规则抓取"));

  await rejection;
  expect(cancel).toHaveBeenCalledOnce();
});
