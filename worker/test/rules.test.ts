// 通过 Worker 顶层 HTTP 入口验证规则目录与内容识别契约。
import { expect, it, vi } from "vitest";
import { createWorkerFixture } from "./fixture";

const rootTree = "https://api.github.com/repos/MetaCubeX/meta-rules-dat/git/trees/meta";
const geoTree = "https://api.github.com/repos/MetaCubeX/meta-rules-dat/git/trees/geo-sha?recursive=1";
const start = Date.UTC(2026, 0, 1);
const ttl = 24 * 60 * 60_000;
const detectPath = "/api/rules/detect";

/**
 * 通过公开初始化端点建立管理员会话。
 * @param fixture 使用独立数据库的 HTTP 夹具。
 * @returns 可用于后续请求的 Cookie。
 * @throws 初始化契约不成立时断言失败。
 */
async function setupCookie(fixture: Awaited<ReturnType<typeof createWorkerFixture>>): Promise<string> {
  const setup = await fixture.request("/api/setup/admin", {
    method: "POST", body: JSON.stringify({ username: "admin", password: "fixture-password", passwordConfirm: "fixture-password" }),
  });
  expect(setup.status).toBe(200);
  const value = setup.headers.get("Set-Cookie");
  if (!value) throw new Error("初始化未签发会话 Cookie");
  return value.split(";", 1)[0];
}

/**
 * 构造 GitHub 规则树响应。
 * @param input GitHub 根树或递归规则树 URL。
 * @param paths 递归树中的规则文件路径。
 * @returns 相应的规则目录响应。
 * @throws 未声明的 URL 不允许访问真实服务。
 */
function githubTree(input: RequestInfo | URL, paths: string[]): Response {
  if (String(input) === rootTree) {
    return Response.json({ tree: [{ type: "tree", path: "geo", sha: "geo-sha" }] });
  }
  if (String(input) === geoTree) {
    return Response.json({ tree: paths.map((path) => ({ type: "blob", path })) });
  }
  throw new Error(`未声明的规则回源：${String(input)}`);
}

/** 冷启动写入 D1 后，后续公开搜索须命中快照且保留抓取时间。 */
it("公开搜索首次回源，随后复用规则快照和分页契约", async () => {
  let now = start;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => githubTree(input, ["geosite/quest.mrs", "geoip/quest.mrs"]));
  await using fixture = await createWorkerFixture({ bindings: { fetch, now: () => now } });
  const path = "/api/rules/search?keyword=QuEsT&type=geosite&page=0&size=999";
  const expected = {
    items: [expect.objectContaining({ id: "quest", url: expect.stringContaining("/geosite/quest.mrs"), availabilityStatus: "available" })],
    keyword: "QuEsT", type: "geosite", page: 1, size: 50, totalMatched: 1, totalRules: 2,
    fetchedAt: start, expiresAt: start + ttl, source: "remote",
  };
  const cold = await fixture.request(path);
  expect(cold.status).toBe(200);
  await expect(cold.json()).resolves.toEqual(expected);
  now += 1_000;
  const warm = await fixture.request(path);
  expect(warm.status).toBe(200);
  await expect(warm.json()).resolves.toEqual(expected);
  expect(fetch.mock.calls.map(([input]) => input)).toEqual([rootTree, geoTree]);
});

/** 缓存搜索保留跨类型排序和分页边界，不需要再次请求远程树。 */
it("在同一规则快照中对 geosite 和 geoip 的重名规则分页", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => githubTree(input, [
    "geoip/quest.mrs", "geosite/quest-extra.mrs", "geosite/quest.mrs",
  ]));
  await using fixture = await createWorkerFixture({ bindings: { fetch, now: () => start } });
  for (const [page, id] of [[1, "quest"], [2, "quest-extra"], [3, "quest-ip"]] as const) {
    const response = await fixture.request(`/api/rules/search?keyword=quest&type=all&size=1&page=${page}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      page, totalMatched: 3, totalRules: 3, source: "remote", items: [{ id }],
    });
  }
  expect(fetch.mock.calls.map(([input]) => input)).toEqual([rootTree, geoTree]);
});

/** 过期回源失败不覆盖 D1 快照；下一次成功回源应替换它。 */
it("过期索引在回源失败时保留旧时间和规则，恢复后换成新索引", async () => {
  let now = start;
  let upstream = "unavailable";
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => upstream === "unavailable"
    ? new Response(null, { status: 503 })
    : githubTree(input, [`geosite/${upstream}.mrs`]));
  await using fixture = await createWorkerFixture({ bindings: { fetch, now: () => now } });
  const path = "/api/rules/search?keyword=quest&type=bogus";
  const missing = await fixture.request(path);
  expect(missing.status).toBe(503);
  await expect(missing.json()).resolves.toEqual({
    items: [], keyword: "quest", type: "all", page: 1, size: 20, totalMatched: 0, totalRules: 0,
    source: "unavailable", error: "规则库暂不可用，请稍后重试", code: "RULE_INDEX_UNAVAILABLE",
  });
  upstream = "quest";
  expect((await fixture.request(path)).status).toBe(200);
  now += ttl;
  upstream = "unavailable";
  const stale = await fixture.request(path);
  expect(stale.status).toBe(200);
  await expect(stale.json()).resolves.toMatchObject({ source: "stale", fetchedAt: start, expiresAt: now, totalMatched: 1 });
  upstream = "replacement";
  const fresh = await fixture.request(path);
  expect(fresh.status).toBe(200);
  await expect(fresh.json()).resolves.toMatchObject({ source: "remote", fetchedAt: now, expiresAt: now + ttl, totalMatched: 0 });
  expect(fetch.mock.calls.map(([input]) => input)).toEqual([rootTree, rootTree, geoTree, rootTree, rootTree, geoTree]);
});

/** 候选是公开入口，复用搜索快照；列表拉取失败保持上游 503 契约。 */
it("从规则快照发现中文候选，按 debug 返回额外字段", async () => {
  let now = start;
  let treeAvailable = true;
  let listAvailable = true;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/geosite/geolocation-cn.list")) return new Response("+.covered.cn\n");
    if (url.endsWith("/geosite/google-cn.list")) {
      return listAvailable ? new Response("+.google.cn\n") : new Response(null, { status: 503 });
    }
    return treeAvailable
      ? githubTree(input, ["geosite/google.mrs", "geosite/google-cn.mrs", "geosite/geolocation-cn.mrs"])
      : new Response(null, { status: 503 });
  });
  await using fixture = await createWorkerFixture({ bindings: { fetch, now: () => now } });
  expect((await fixture.request("/api/rules/search")).status).toBe(200);
  now += 5_000;
  const path = "/api/rules/cn-candidates?modules=google,unknown,google";
  const debug = await fixture.request(`${path}&debug=1`);
  expect(debug.status).toBe(200);
  const candidate = expect.objectContaining({ id: "google-cn", actionable: true });
  await expect(debug.json()).resolves.toEqual({
    items: [candidate], allItems: [candidate], source: "remote",
    cache: { fetchedAt: start, expiresAt: start + ttl, ttlMs: ttl },
  });
  expect(fetch.mock.calls.filter(([input]) => String(input).includes("/git/trees/"))).toHaveLength(2);
  now = start + ttl;
  treeAvailable = false;
  const stale = await fixture.request(path);
  expect(stale.status).toBe(200);
  await expect(stale.json()).resolves.toEqual({
    items: [candidate], source: "stale", cache: { fetchedAt: start, expiresAt: now, ttlMs: ttl },
  });
  listAvailable = false;
  const unavailable = await fixture.request(path);
  expect(unavailable.status).toBe(503);
  await expect(unavailable.json()).resolves.toMatchObject({ items: [], source: "unavailable", code: "RULE_INDEX_UNAVAILABLE" });
  fetch.mockClear();
  const excluded = await fixture.request("/api/rules/cn-candidates?modules=google&excluded=google:google");
  expect(excluded.status).toBe(200);
  await expect(excluded.json()).resolves.toEqual({
    items: [], source: "remote", cache: { fetchedAt: now, expiresAt: now + ttl, ttlMs: ttl },
  });
  expect(fetch).not.toHaveBeenCalled();
});

/** 识别必须有管理员会话，并返回由正文决定的类型、而不是文件扩展名。 */
it("仅允许管理员识别规则，且不会把规则正文返回给客户端", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("payload: ['+.example.test']"));
  await using fixture = await createWorkerFixture({ bindings: { fetch, ENCRYPTION_KEY: "fixture-encryption-key" } });
  const url = "https://rules.example.test/domains.txt?key=fixture";
  const body = JSON.stringify({ url });
  const unauthorized = await fixture.request(detectPath, { method: "POST", body });
  expect(unauthorized.status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
  const cookie = await setupCookie(fixture);
  const response = await fixture.request(detectPath, { method: "POST", body, headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual({ path: url, name: "domains", behavior: "domain", format: "yaml" });
  expect(fetch.mock.calls.map(([input]) => input)).toEqual([url]);
});

/** 识别不绕过共享请求体限制或 Worker 出站限制，也不会泄漏回源错误细节。 */
it("拒绝超限请求体、回环和不安全重定向，区分抓取与格式错误", async () => {
  const redirectUrl = "https://rules.example.test/redirect";
  const largeUrl = "https://rules.example.test/large";
  const invalidUrl = "https://rules.example.test/unrecognized";
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    if (input === redirectUrl) return Response.redirect("http://127.0.0.1/private.list");
    if (input === largeUrl) return new Response("+.example.test\n", { headers: { "Content-Length": "10485761" } });
    if (input === invalidUrl) return new Response("<html>not a rule file</html>");
    throw new Error(`不应访问：${String(input)}`);
  });
  await using fixture = await createWorkerFixture({ bindings: { fetch, ENCRYPTION_KEY: "fixture-encryption-key" } });
  const cookie = await setupCookie(fixture);
  for (const [body, status, code] of [
    ["x".repeat(65_537), 413, "BAD_REQUEST"],
    [JSON.stringify({ url: "https://user:pass@rules.example.test/list" }), 400, "BAD_REQUEST"],
    [JSON.stringify({ url: "http://[::1]/private.list" }), 422, "FETCH_FAILED"],
    [JSON.stringify({ url: redirectUrl }), 422, "FETCH_FAILED"],
    [JSON.stringify({ url: largeUrl }), 422, "FETCH_FAILED"],
    [JSON.stringify({ url: invalidUrl }), 422, "UNSUPPORTED_RULE_CONTENT"],
  ] as const) {
    const response = await fixture.request(detectPath, { method: "POST", body, headers: { Cookie: cookie } });
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ code });
  }
  expect(fetch.mock.calls.map(([input]) => input)).toEqual([redirectUrl, largeUrl, invalidUrl]);
});

/** 限流按管理员而不是访客 IP 计数，窗口结束后恢复识别。 */
it("在一小时窗口内将同一管理员的识别限制为 30 次", async () => {
  let now = start;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("+.example.test\n"));
  await using fixture = await createWorkerFixture({
    bindings: { fetch, ENCRYPTION_KEY: "fixture-encryption-key", now: () => now },
  });
  const cookie = await setupCookie(fixture);
  const body = JSON.stringify({ url: "https://rules.example.test/domains.list" });
  for (let attempt = 0; attempt < 30; attempt++) {
    expect((await fixture.request(detectPath, {
      method: "POST", body, headers: { Cookie: cookie, "CF-Connecting-IP": `192.0.2.${attempt + 1}` },
    })).status).toBe(200);
  }
  const limited = await fixture.request(detectPath, { method: "POST", body, headers: { Cookie: cookie } });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("3600");
  await expect(limited.json()).resolves.toEqual({ error: "规则识别过于频繁，请稍后重试", code: "RATE_LIMITED" });
  expect(fetch).toHaveBeenCalledTimes(30);
  now += 60 * 60_000;
  expect((await fixture.request(detectPath, { method: "POST", body, headers: { Cookie: cookie } })).status).toBe(200);
  expect(fetch).toHaveBeenCalledTimes(31);
});
