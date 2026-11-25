// 通过 Worker 顶层 HTTP 与真实 D1 验证管理员认证契约。
import { expect, it } from "vitest";
import { createWorkerFixture } from "./fixture";

const bindings = { ENCRYPTION_KEY: "fixture-encryption-key" };
const credentials = { username: "admin", password: "fixture-password", passwordConfirm: "fixture-password" };

/**
 * 构造认证请求的 JSON 及额外请求头。
 * @param body 要发送的凭据。
 * @param headers 场景需要的附加请求头。
 * @returns 可直接传给顶层 HTTP 夹具的请求选项。
 */
function post(body: object, headers: Record<string, string> = {}): RequestInit {
  return { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } };
}

/**
 * 提取下次请求可发送的会话 Cookie。
 * @param response 签发会话的响应。
 * @returns Cookie 名和值。
 * @throws 响应未签发预期的会话 Cookie 时断言失败。
 */
function sessionCookie(response: Response): string {
  const cookie = response.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";
  expect(cookie).toMatch(/^subboost_local_session=[\w-]+\.[\w-]+\.[\w-]+$/);
  return cookie;
}

/** 并发安装只创建一个管理员，获胜请求同时赢得会话。 */
it("初始化时自动登录，且不同账号并发初始化只有一条成功", async () => {
  // 竞争不同用户名，避免仅靠用户名唯一约束侥幸防住并发。
  await using fixture = await createWorkerFixture({ bindings });
  const first = await fixture.request("/api/auth/me");
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ setupRequired: true, setupTokenRequired: false, authenticated: false, user: null });

  const results = await Promise.all(["first", "second"].map((username) =>
    fixture.request("/api/setup/admin", post({ ...credentials, username }))));
  expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
  const winnerResponse = results.find((result) => result.ok)!;
  const winner = await winnerResponse.json<{ success: boolean; user: { id: string; username: string } }>();
  expect(winner).toEqual({ success: true, user: { id: expect.any(String), username: expect.stringMatching(/^(first|second)$/) } });
  const me = await fixture.request("/api/auth/me", { headers: { Cookie: sessionCookie(winnerResponse) } });
  expect(await me.json()).toMatchObject({ setupRequired: false, authenticated: true, user: {
    ...winner.user, name: winner.user.username, subscriptionCount: 0, templateCount: 0,
    quota: { maxSubscriptions: 9999, maxNodesPerSubscription: 10000, canUseSubscriptionLink: true },
  } });
});

/** 令牌只控制首次安装，已有账号不可覆盖。 */
it("配置初始化令牌时，正确令牌才能首次创建管理员，之后永久冲突", async () => {
  await using fixture = await createWorkerFixture({ bindings: { ...bindings, LOCAL_SETUP_TOKEN: "private-setup" } });
  expect(await (await fixture.request("/api/auth/me")).json()).toMatchObject({ setupRequired: true, setupTokenRequired: true });
  for (const token of [undefined, "incorrect"]) {
    const denied = await fixture.request("/api/setup/admin", post(credentials, token ? { "X-SubBoost-Setup-Token": token } : {}));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "FORBIDDEN" });
  }
  const success = await fixture.request("/api/setup/admin", post(credentials, { "X-SubBoost-Setup-Token": "private-setup" }));
  expect(success.status).toBe(200);
  expect(await (await fixture.request("/api/auth/me")).json()).toMatchObject({ setupRequired: false, setupTokenRequired: false });
  const duplicate = await fixture.request("/api/setup/admin", post({}));
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ code: "CONFLICT" });
});

/** 密码必须先验证，Cookie 的 Secure 由访问协议决定。 */
it("拒绝错误密码，正确密码签发由请求 URL 决定 Secure 的七天会话", async () => {
  await using fixture = await createWorkerFixture({ bindings });
  const setup = await fixture.request("/api/setup/admin", post(credentials));
  expect(setup.status).toBe(200);
  const bad = await fixture.request("/api/auth/login", post({ ...credentials, password: "incorrect" }));
  expect(bad.status).toBe(401);
  expect(await bad.json()).toMatchObject({ code: "UNAUTHORIZED" });
  expect(bad.headers.has("Set-Cookie")).toBe(false);

  const response = await fixture.request("https://custom.example/api/auth/login", post(credentials, {
    Origin: "http://fake.example", Forwarded: "proto=http;host=fake.example", "X-Forwarded-Proto": "http",
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ success: true, user: { id: expect.any(String), username: "admin" } });
  expect(response.headers.get("Set-Cookie")).toMatch(/; Secure(?:;|$)/);
  expect(response.headers.get("Set-Cookie")).toContain("Max-Age=604800");
  expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
  expect(response.headers.get("Set-Cookie")).toContain("SameSite=Lax");
  expect(response.headers.get("Set-Cookie")).toContain("Path=/");
  expect(response.headers.get("Set-Cookie")).not.toContain("Domain=");
  expect(await (await fixture.request("/api/auth/me", { headers: { Cookie: sessionCookie(response) } })).json())
    .toMatchObject({ authenticated: true });

  const local = await fixture.request("http://localhost:8787/api/auth/login", post(credentials, { Origin: "https://fake.example" }));
  expect(local.status).toBe(200);
  expect(local.headers.get("Set-Cookie")).not.toMatch(/; Secure(?:;|$)/);
  fixture.env.APP_URL = "https://configured.example/prefix";
  const configured = await fixture.request("http://localhost:8787/api/auth/login", post(credentials));
  expect(configured.headers.get("Set-Cookie")).toMatch(/; Secure(?:;|$)/);
});

/** 退出只吊销对应会话，不波及另一登录。 */
it("退出后，同一个已签发的 Cookie 立即失效，但另一会话仍有效", async () => {
  await using fixture = await createWorkerFixture({ bindings });
  const setup = await fixture.request("/api/setup/admin", post(credentials));
  const cookie = sessionCookie(setup);
  const another = sessionCookie(await fixture.request("/api/auth/login", post(credentials)));
  const logout = await fixture.request("/api/auth/logout", { method: "POST", headers: { Cookie: cookie } });
  expect(logout.status).toBe(200);
  expect(await logout.json()).toEqual({ success: true });
  expect(logout.headers.get("Set-Cookie")).toContain("subboost_local_session=; Max-Age=0");
  for (const [credential, authenticated] of [[cookie, false], [another, true]] as const) {
    const me = await fixture.request("/api/auth/me", { headers: { Cookie: credential } });
    expect(await me.json()).toMatchObject({ authenticated });
  }
  const again = await fixture.request("/api/auth/logout", { method: "POST", headers: { Cookie: cookie } });
  expect(again.status).toBe(200);
});

/** 限流跨请求与并发共享，伪造转发头不可换桶。 */
it("并发登录尝试共享 D1 限额，转发头不切换桶且窗口结束后恢复", async () => {
  let now = Date.UTC(2026, 0, 1);
  await using fixture = await createWorkerFixture({ bindings: { ...bindings, now: () => now } });
  expect((await fixture.request("/api/setup/admin", post(credentials))).status).toBe(200);
  const outcomes = await Promise.all(Array.from({ length: 10 }, (_, index) => fixture.request("/api/auth/login",
    post({ ...credentials, password: "incorrect" }, { "CF-Connecting-IP": "192.0.2.1", "X-Forwarded-For": `198.51.100.${index}` }))));
  expect(outcomes.filter((response) => response.status === 401)).toHaveLength(8);
  const blocked = outcomes.filter((response) => response.status === 429);
  expect(blocked).toHaveLength(2);
  expect(blocked[0].headers.get("Retry-After")).toBe("900");
  expect(await blocked[0].json()).toMatchObject({ code: "RATE_LIMITED" });

  const otherIp = await fixture.request("/api/auth/login", post(credentials, { "CF-Connecting-IP": "192.0.2.2" }));
  expect(otherIp.status).toBe(200);
  now += 15 * 60_000;
  const fresh = await fixture.request("/api/auth/login", post(credentials, { "CF-Connecting-IP": "192.0.2.1" }));
  expect(fresh.status).toBe(200);
});

/** 初始化令牌失败也计入限额，但不消耗登录限额。 */
it("初始化令牌验证前即跨请求限流，且与登录限额独立", async () => {
  await using fixture = await createWorkerFixture({ bindings: { ...bindings, LOCAL_SETUP_TOKEN: "private-setup" } });
  const wrong = await Promise.all(Array.from({ length: 5 }, () => fixture.request("/api/setup/admin", post(credentials))));
  expect(wrong.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
  const limited = await fixture.request("/api/setup/admin", post(credentials, { "X-SubBoost-Setup-Token": "private-setup" }));
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  const login = await fixture.request("/api/auth/login", post(credentials));
  expect(login.status).toBe(401);
});

/** 密钥缺失给出可识别的中文部署指引。 */
it("缺少 ENCRYPTION_KEY 时健康检查和认证均返回中文配置指引", async () => {
  await using fixture = await createWorkerFixture({ migrate: false, bindings: { ENCRYPTION_KEY: "  ", JWT_SECRET: "not-a-substitute" } });
  for (const [path, init] of [
    ["/api/health/ready", undefined], ["/api/auth/me", undefined], ["/api/setup/admin", post(credentials)],
    ["/api/auth/login", post(credentials)], ["/api/auth/logout", { method: "POST" }],
  ] as const) {
    const response = await fixture.request(path, init);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "ENCRYPTION_KEY_MISSING", message: expect.stringMatching(/设置.*变量和机密.*ENCRYPTION_KEY/) });
    expect(response.headers.has("Set-Cookie")).toBe(false);
  }
});

/** 会话支持单独轮换密钥并有绝对有效期。 */
it("独立 JWT_SECRET 可轮换，会话拒绝篡改且签发七天后过期", async () => {
  let now = Date.UTC(2026, 0, 1);
  await using fixture = await createWorkerFixture({ bindings: { ...bindings, JWT_SECRET: "fixture-signing-key", now: () => now } });
  const cookie = sessionCookie(await fixture.request("/api/setup/admin", post(credentials)));
  const signatureStart = cookie.lastIndexOf(".") + 1;
  const tampered = `${cookie.slice(0, signatureStart)}${cookie[signatureStart] === "A" ? "B" : "A"}${cookie.slice(signatureStart + 1)}`;
  expect(await (await fixture.request("/api/auth/me", { headers: { Cookie: tampered } })).json()).toMatchObject({ authenticated: false });

  fixture.env.ENCRYPTION_KEY = "rotated-data-key";
  const request = { headers: { Cookie: cookie } };
  expect(await (await fixture.request("/api/auth/me", request)).json()).toMatchObject({ authenticated: true });
  fixture.env.JWT_SECRET = "rotated-signing-key";
  expect(await (await fixture.request("/api/auth/me", request)).json()).toMatchObject({ authenticated: false });
  fixture.env.JWT_SECRET = "fixture-signing-key";
  now += 7 * 24 * 60 * 60_000;
  expect(await (await fixture.request("/api/auth/me", request)).json()).toMatchObject({ authenticated: false });
});

/** 吊销失败时保留会话，允许重试退出。 */
it("D1 吊销失败时不报告退出成功，也不清除待重试会话", async () => {
  await using initialized = await createWorkerFixture({ bindings });
  await using unavailable = await createWorkerFixture({ bindings, migrate: false });
  const cookie = sessionCookie(await initialized.request("/api/setup/admin", post(credentials)));
  const response = await unavailable.request("/api/auth/logout", { method: "POST", headers: { Cookie: cookie } });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "SESSION_STORE_UNAVAILABLE" });
  expect(response.headers.has("Set-Cookie")).toBe(false);
});

/** 保持初始化请求大小与错误响应兼容。 */
it("初始化保留原版的 JSON、请求体大小与密码确认错误契约", async () => {
  await using fixture = await createWorkerFixture({ bindings });
  const invalidJson = await fixture.request("/api/setup/admin", { method: "POST", body: "{" });
  expect(invalidJson.status).toBe(400);
  expect(await invalidJson.json()).toEqual({ code: "BAD_REQUEST", error: "请求格式有误，请刷新页面后重试" });
  const tooLarge = await fixture.request("/api/setup/admin", post({ ...credentials, password: "x".repeat(64 * 1024) }));
  expect(tooLarge.status).toBe(413);
  expect(await tooLarge.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  const mismatch = await fixture.request("/api/setup/admin", post({ ...credentials, passwordConfirm: "different-password" }));
  expect(mismatch.status).toBe(400);
  expect(await mismatch.json()).toEqual({ code: "BAD_REQUEST", error: "两次输入的密码不一致，请重新确认" });
  expect(await (await fixture.request("/api/auth/me")).json()).toMatchObject({ setupRequired: true, authenticated: false });
});
