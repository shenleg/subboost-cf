// 通过 Worker 顶层入口和真实 D1 验证 Cron 调度与 HTTP 契约。
import { fileURLToPath, URL as NodeURL } from "node:url";
import { unstable_readConfig } from "wrangler";
import parity from "../../docs/worker-parity.json";
import { expect, it } from "vitest";
import { createWorkerFixture } from "./fixture";

const wranglerConfig = fileURLToPath(new NodeURL("../../wrangler.jsonc", import.meta.url));
const subscriptionCron = "/api/cron/update-subscriptions";
const ruleIndexCron = "/api/cron/update-rule-index";

/** 验证部署配置和机器人清单声明完全相同的原生触发器。 */
it("Wrangler Cron 触发器与机器可读 parity 一致", () => {
  const { triggers } = unstable_readConfig({ config: wranglerConfig });
  expect([...(triggers.crons ?? [])].sort()).toEqual(parity.schedules.map(({ cron }) => cron).sort());
  expect(parity.schedules.map(({ localTrigger }) => localTrigger).sort()).toEqual([
    `POST ${ruleIndexCron}`, `POST ${subscriptionCron}`,
  ]);
});

/**
 * 从公开 parity 清单选择入口表达式，让原生任务契约测试覆盖实际部署映射。
 * @param route 该原生任务对应的 HTTP 路径。
 * @returns 该任务在清单中声明的原生表达式。
 * @throws 清单未映射此路径时抛出。
 */
function configuredSchedule(route: string) {
  const schedule = parity.schedules.find(({ localTrigger }) => localTrigger === `POST ${route}`);
  if (!schedule) throw new Error(`Cron parity 缺少 ${route}`);
  return schedule.cron;
}

/** 未配置的 Cron 不需要访问数据库或外部服务。 */
it("忽略未配置的原生 Cron 表达式", async () => {
  await using fixture = await createWorkerFixture({ migrate: false });

  await expect(fixture.scheduled("* * * * *")).resolves.toBeUndefined();
});

/** 规则索引原生更新与受保护的 HTTP 强制刷新共用 D1 快照。 */
it("定时更新规则索引，不依赖 CRON_SECRET；HTTP 则要求正确的 Bearer", async () => {
  const calls: string[] = [];
  await using fixture = await createWorkerFixture({ bindings: { fetch: async (input) => {
    const url = String(input);
    calls.push(url);
    return Response.json({ tree: url.includes("?recursive=1")
      ? [{ type: "blob", path: "geosite/cron-test.mrs" }] : [] });
  } } });
  const path = ruleIndexCron;
  const init = { method: "POST", headers: { Authorization: "Bearer cron-test-secret" } };

  expect((await fixture.request(path, init)).status).toBe(503);
  await fixture.scheduled(configuredSchedule(ruleIndexCron));
  expect(calls.length).toBeGreaterThan(0);
  const initialCalls = calls.length;
  fixture.env.CRON_SECRET = "cron-test-secret";
  expect((await fixture.request(path, { method: "POST" })).status).toBe(401);
  const cached = await fixture.request(path, init);
  expect(cached.status).toBe(200);
  expect(await cached.json()).toMatchObject({ success: true, status: "skipped", source: expect.any(String) });
  expect(calls).toHaveLength(initialCalls);
  const forced = await fixture.request(`${path}?force=1`, init);
  expect(forced.status).toBe(200);
  expect(await forced.json()).toMatchObject({ success: true, status: "refreshed" });
  expect(calls).toHaveLength(initialCalls * 2);
  await fixture.scheduled(configuredSchedule(ruleIndexCron));
  expect(calls).toHaveLength(initialCalls * 3);
});

const cronInit = { method: "POST", headers: { Authorization: "Bearer cron-test-secret" } };
const sourceNode = "ss://YWVzLTEyOC1nY206cGFzcw@new.example:443#New";
const savedNode = { name: "Old", type: "ss", server: "old.example", port: 443, cipher: "aes-128-gcm", password: "pass" };
const epoch = Date.UTC(2026, 0, 1);
const tick = 360_000;
type Fixture = Awaited<ReturnType<typeof createWorkerFixture>>;

/**
 * 通过 HTTP 初始化管理员。
 * @param fixture 当前测试使用的空 Worker 环境。
 * @returns 后续请求需要的会话和 JSON 请求头。
 * @throws 初始化未成功时断言报错。
 */
async function initialize(fixture: Fixture) {
  const res = await fixture.request("/api/setup/admin", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "cron-test-password", passwordConfirm: "cron-test-password" }) });
  expect(res.status).toBe(200);
  return { Cookie: res.headers.get("Set-Cookie")!.split(";")[0], "Content-Type": "application/json" };
}

/**
 * 保存用于自动刷新的订阅。
 * @param fixture 当前 Worker 环境。
 * @param headers 管理员会话和 JSON 请求头。
 * @param name 便于区分的订阅名。
 * @param urls 保存的外部订阅源。
 * @param extra 覆盖默认请求字段的场景配置。
 * @returns 订阅管理路径。
 * @throws 创建失败时断言报错。
 */
async function create(fixture: Fixture, headers: HeadersInit, name: string, urls: string[], extra = {}) {
  const response = await fixture.request("/api/subscriptions", { method: "POST", headers,
    body: JSON.stringify({ name, nodes: [savedNode], urls, autoUpdateInterval: 360, ...extra }) });
  expect(response.status).toBe(201);
  const { subscription } = await response.json() as { subscription: { id: string } };
  return `/api/subscriptions/${subscription.id}`;
}

/**
 * 读取管理员可见的订阅状态。
 * @param fixture 当前 Worker 环境。
 * @param headers 管理员会话请求头。
 * @param path 被查询的订阅管理路径。
 * @returns 订阅详情，包括公开可观察的刷新状态。
 * @throws 查询失败时断言报错。
 */
async function read(fixture: Fixture, headers: HeadersInit, path: string) {
  const response = await fixture.request(path, { headers });
  expect(response.status).toBe(200);
  return (await response.json<{ subscription: Record<string, unknown> }>()).subscription;
}

/** 最老的短周期失败项再次到期时，已承诺的下一批仍能获得机会。 */
it("按最久未更新处理三条到期订阅，下一轮优先接力后排", async () => {
  let now = epoch;
  const calls = new Set<string>();
  await using fixture = await createWorkerFixture({ bindings: { ENCRYPTION_KEY: "cron-test", now: () => now,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      calls.add(path);
      return path === "/old0" ? new Response(null, { status: 503 }) : new Response(sourceNode);
    },
  } });
  const headers = await initialize(fixture);
  const paths: string[] = [];
  for (let i = 0; i < 7; i++) {
    if (i === 1) await create(fixture, headers, "尚未到期", ["https://source.example/not-due"], { autoUpdateInterval: 3600 });
    paths.push(await create(fixture, headers, `订阅 ${i}`, [`https://source.example/old${i}`]));
    now++;
  }
  now += tick;
  await fixture.scheduled(configuredSchedule(subscriptionCron));
  expect([...calls]).toEqual(["/old0", "/old1", "/old2"]);
  expect(await read(fixture, headers, paths[1])).toMatchObject({ lastUpdatedAt: new Date(now).toISOString(),
    nodes: expect.arrayContaining([expect.objectContaining({ name: "New" })]) });

  fixture.env.CRON_SECRET = "cron-test-secret";
  for (const expected of [["/old3", "/old4", "/old5"], ["/old6"]]) {
    now += tick;
    calls.clear();
    const response = await fixture.request(subscriptionCron, cronInit);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, results: { updated: expected.length }, timestamp: new Date(now).toISOString() });
    expect([...calls]).toEqual(expected);
  }
});

/** 多源单订阅跨过 50 次硬预算时可续跑，且下一个到期订阅不必等待它完成。 */
it("按实际重定向与 UA 计量，跨轮重放已完成回调且不把延后记为失败", async () => {
  let now = epoch;
  let redirect = false;
  const calls: string[] = [];
  await using fixture = await createWorkerFixture({ bindings: {
    ENCRYPTION_KEY: "cron-test", CRON_SECRET: "cron-test-secret", now: () => now,
    fetch: async (input) => {
      const url = new URL(String(input));
      calls.push(url.pathname + url.search);
      const hop = Number(url.searchParams.get("hop") ?? 0);
      if (redirect && url.pathname.startsWith("/big") && hop < 3) {
        return new Response(null, { status: 302, headers: { Location: `?hop=${hop + 1}` } });
      }
      return url.pathname === "/big0" ? new Response(null, { status: 404 }) : new Response(sourceNode);
    },
  } });
  const headers = await initialize(fixture);
  const big = await create(fixture, headers, "多源订阅", Array.from({ length: 5 }, (_, i) => `https://source.example/big${i}`));
  for (const tickNumber of [1, 2]) {
    now = epoch + tickNumber * tick;
    await fixture.scheduled(configuredSchedule(subscriptionCron));
  }
  calls.length = 0;
  redirect = true;
  now++;
  const small = await create(fixture, headers, "后排订阅", ["https://source.example/small"]);
  const unchanged = await read(fixture, headers, big);
  expect(unchanged).toMatchObject({ autoUpdateInterval: 360, autoUpdateState: { externalFailureCount: 2 } });
  now += tick;

  const deferred = await fixture.request(subscriptionCron, cronInit);
  expect(deferred.status).toBe(200);
  expect(await deferred.json()).toMatchObject({ budgetDeferred: 1, results: { updated: 0, failed: 0 } });
  expect(calls).toHaveLength(48);
  expect(new Set(calls.map((url) => url.split("?")[0]))).toEqual(new Set(["/big0", "/big1", "/big2"]));
  expect(await read(fixture, headers, big)).toEqual(unchanged);

  calls.length = 0;
  await fixture.scheduled(configuredSchedule(subscriptionCron));
  expect(new Set(calls)).toEqual(new Set(["/small"]));
  expect(await read(fixture, headers, small)).toMatchObject({ lastUpdatedAt: new Date(now).toISOString() });

  calls.length = 0;
  await fixture.scheduled(configuredSchedule(subscriptionCron));
  expect(calls).toHaveLength(32);
  expect(new Set(calls.map((url) => url.split("?")[0]))).toEqual(new Set(["/big3", "/big4"]));
  expect(await read(fixture, headers, big)).toMatchObject({ lastUpdatedAt: new Date(now).toISOString(),
    autoUpdateInterval: null, autoUpdateState: { externalFailureCount: 3 } });
});

/** 验证原生、HTTP 同锁；过期的旧调用无法提交或释放新调用的锁。 */
it("并发重入时跳过，过期易主后旧调用返回 JOB_LEASE_LOST", async () => {
  let now = epoch;
  const oldEntered = Promise.withResolvers<void>();
  const oldProceed = Promise.withResolvers<void>();
  const newEntered = Promise.withResolvers<void>();
  const newProceed = Promise.withResolvers<void>();
  await using fixture = await createWorkerFixture({ bindings: {
    ENCRYPTION_KEY: "cron-test", CRON_SECRET: "cron-test-secret", now: () => now,
    fetch: async () => {
      oldEntered.resolve();
      await oldProceed.promise;
      return new Response(null, { status: 404 });
    },
  } });
  const headers = await initialize(fixture);
  const path = await create(fixture, headers, "并发订阅", ["https://source.example/lease"]);
  now += tick;
  const old = fixture.request(subscriptionCron, cronInit);
  let newRun: Promise<void> | undefined;
  try {
    await oldEntered.promise;
    const skip = await fixture.request(subscriptionCron, cronInit);
    expect(skip.status).toBe(200);
    expect(await skip.json()).toEqual({ success: true, skipped: true, reason: "already_running" });
    now += 5 * 60_000;
    fixture.env.fetch = async () => {
      newEntered.resolve();
      await newProceed.promise;
      return new Response(sourceNode);
    };
    newRun = fixture.scheduled(configuredSchedule(subscriptionCron));
    await newEntered.promise;
    oldProceed.resolve();
    const lost = await old;
    expect(lost.status).toBe(503);
    expect(await lost.json()).toMatchObject({ code: "JOB_LEASE_LOST" });
    expect(await (await fixture.request(subscriptionCron, cronInit)).json()).toMatchObject({ reason: "already_running" });
    expect(await read(fixture, headers, path)).toMatchObject({ lastUpdatedAt: null, nodes: [savedNode] });
  } finally {
    oldProceed.resolve();
    newProceed.resolve();
    await Promise.allSettled([old, newRun]);
  }
  expect(await read(fixture, headers, path)).toMatchObject({ lastUpdatedAt: new Date(now).toISOString(),
    autoUpdateState: { externalFailureCount: 0 } });
});

/** 订阅版本在同毫秒变更也不能被有有效租约的旧快照覆盖。 */
it("Cron 进行中编辑订阅，旧快照不能更新缓存或失败状态", async () => {
  let now = epoch;
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  await using fixture = await createWorkerFixture({ bindings: { ENCRYPTION_KEY: "cron-test", CRON_SECRET: "cron-test-secret", now: () => now,
    fetch: async () => {
      entered.resolve();
      await proceed.promise;
      return new Response(null, { status: 404 });
    },
  } });
  const headers = await initialize(fixture);
  const path = await create(fixture, headers, "待编辑", ["https://source.example/old"]);
  now += tick;
  const running = fixture.request(subscriptionCron, cronInit);
  try {
    await entered.promise;
    expect((await fixture.request(path, { method: "PUT", headers, body: JSON.stringify({ name: "已编辑" }) })).status).toBe(200);
  } finally {
    proceed.resolve();
  }
  const result = await running;
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ results: { skipped: 1, updated: 0, failed: 0 }, topHosts: [] });
  expect(await read(fixture, headers, path)).toMatchObject({ name: "已编辑", lastUpdatedAt: null, nodes: [savedNode],
    autoUpdateState: { externalFailureCount: 0, lastAttemptedAt: null } });
});

/** 只清理一小批过期条目，不影响尚未到期的认证状态。 */
it("订阅 Cron 限量清理过期吊销会话和认证限流记录", async () => {
  await using fixture = await createWorkerFixture({ bindings: { ENCRYPTION_KEY: "cron-test", now: () => epoch } });
  const { db } = fixture;
  // 清理没有外部查询接口，直接播种并观察两张运行表，其他用例通过 Worker 入口观察业务数据。
  await db.batch(Array.from({ length: 41 }, (_, i) => db.prepare(`INSERT INTO RevokedSession
    (revocationKey, expiresAt, createdAt) VALUES (?, ?, ?)`).bind(String(i), i === 40 ? epoch + 1 : epoch, epoch - 1)));
  await db.batch(Array.from({ length: 41 }, (_, i) => db.prepare(`INSERT INTO AuthRateLimit
    (scope, ipHash, count, resetAt) VALUES ('cleanup', ?, 1, ?)`).bind(String(i), i === 40 ? epoch + 1 : epoch)));
  for (const expected of [21, 1]) {
    await fixture.scheduled(configuredSchedule(subscriptionCron));
    expect(await db.prepare("SELECT COUNT(*) AS n FROM RevokedSession").first("n")).toBe(expected);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM AuthRateLimit").first("n")).toBe(expected);
  }
  expect(await db.prepare("SELECT revocationKey FROM RevokedSession").first("revocationKey")).toBe("40");
  expect(await db.prepare("SELECT ipHash FROM AuthRateLimit").first("ipHash")).toBe("40");
});

/** 单个稳定失败来源连续三次即停用，其他来源成功也不能清掉它的计数。 */
it("部分来源成功时仍发布新缓存；同一来源第三次稳定失败后停用", async () => {
  let now = epoch;
  let gone = false;
  let calls = 0;
  await using fixture = await createWorkerFixture({ bindings: {
    ENCRYPTION_KEY: "cron-test", CRON_SECRET: "cron-test-secret", now: () => now,
    fetch: async (input) => {
      calls++;
      if (new URL(String(input)).pathname === "/gone") {
        if (gone) return new Response(null, { status: 404 });
        return new Response(sourceNode.replace("new.example", "retained.example").replace("#New", "#Retained"));
      }
      return new Response(sourceNode);
    },
  } });
  const headers = await initialize(fixture);
  const path = await create(fixture, headers, "部分失败", ["https://source.example/good", "https://source.example/gone"]);
  now += tick;
  await fixture.scheduled(configuredSchedule(subscriptionCron));
  gone = true;
  for (const count of [1, 2, 3]) {
    now += tick;
    const response = await fixture.request(subscriptionCron, cronInit);
    expect(await response.json()).toMatchObject({ results: { updated: 1, failed: 0 } });
    expect(await read(fixture, headers, path)).toMatchObject({
      autoUpdateInterval: count < 3 ? 360 : null,
      autoUpdateState: { externalFailureCount: count, nodeQuotaFailureCount: 0, disabledAt: count < 3 ? null : new Date(now).toISOString() },
      nodes: expect.arrayContaining([expect.objectContaining({ name: "New" }), expect.objectContaining({ name: "Retained" })]),
    });
  }
  now += tick;
  const prior = calls;
  await fixture.scheduled(configuredSchedule(subscriptionCron));
  expect(calls).toBe(prior);
});

/** 超节点配额与 D1 字节上限不同；原版第三次连续超配额停用，旧节点保留。 */
it("连续三次超过节点上限后停用，历史快照不被覆盖", async () => {
  let now = epoch;
  // 单个源的解析上限也是 10,000；两个各自合法的源才能跨过聚合订阅配额。
  const bodies = [0, 5000].map((offset) => JSON.stringify({ proxies: Array.from({ length: 5000 }, (_, index) => {
    const i = offset + index;
    return { ...savedNode, name: `Node ${i}`, server: `n${i}.example` };
  }) }));
  await using fixture = await createWorkerFixture({ bindings: {
    ENCRYPTION_KEY: "cron-test", CRON_SECRET: "cron-test-secret", now: () => now,
    fetch: async (input) => new Response(bodies[new URL(String(input)).pathname === "/a" ? 0 : 1]),
  } });
  const headers = await initialize(fixture);
  const path = await create(fixture, headers, "超节点配额", ["https://source.example/a", "https://source.example/b"]);
  for (const count of [1, 2, 3]) {
    now += tick;
    const response = await fixture.request(subscriptionCron, cronInit);
    expect(await response.json()).toMatchObject({ results: { failed: 1 }, storageLimited: 0 });
    expect(await read(fixture, headers, path)).toMatchObject({ nodes: [savedNode], lastUpdatedAt: null,
      autoUpdateInterval: count < 3 ? 360 : null,
      autoUpdateState: { nodeQuotaFailureCount: count, externalFailureCount: 0, lastNodeQuotaLimit: 10000 },
    });
  }
}, 20_000);


/** 配置更小的批次和出站额度时，仍能完成包含流量 HEAD 的最坏情况回调。 */
it("尊重批次和 fetch 限制，并以 20 次预算完成流量补取及后续续跑", async () => {
  let now = epoch;
  const calls: string[] = [];
  await using fixture = await createWorkerFixture({ bindings: {
    ENCRYPTION_KEY: "cron-test", CRON_SECRET: "cron-test-secret", CRON_BATCH_SIZE: "1", CRON_FETCH_LIMIT: "20", now: () => now,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const hop = Number(url.searchParams.get("hop") ?? 0);
      if (hop < 3) return new Response(null, { status: 302, headers: { Location: `?hop=${hop + 1}` } });
      return init?.method === "HEAD" ? new Response(null, { headers: { "subscription-userinfo": "upload=1024; download=2048; total=4096" } })
        : new Response(sourceNode);
    },
  } });
  const headers = await initialize(fixture);
  const source = "https://source.example/content";
  const first = await create(fixture, headers, "流量补取", [source],
    { config: { sources: [{ id: "cron", type: "url", content: source, userinfoUrl: "https://source.example/info" }] } });
  now++;
  const second = await create(fixture, headers, "静态订阅", []);
  now += tick;
  const result = await fixture.request(subscriptionCron, cronInit);
  expect(await result.json()).toMatchObject({ budgetDeferred: 1, results: { total: 1, failed: 0 } });
  expect(calls).toHaveLength(20);
  expect(calls.filter((call) => call === "HEAD /info")).toHaveLength(4);
  expect(await read(fixture, headers, first)).toMatchObject({ lastUpdatedAt: null, autoUpdateState: { lastAttemptedAt: null } });

  calls.length = 0;
  await fixture.scheduled(configuredSchedule(subscriptionCron));
  expect(await read(fixture, headers, second)).toMatchObject({ lastUpdatedAt: new Date(now).toISOString() });
  expect(calls).toHaveLength(0);
  await fixture.scheduled(configuredSchedule(subscriptionCron));
  expect(calls).toEqual(Array(4).fill("HEAD /info"));
  expect(await read(fixture, headers, first)).toMatchObject({ lastUpdatedAt: new Date(now).toISOString(), subscriptionInfo: { total: expect.any(Number) } });
});

/** 续租覆盖原到期点；续期不需要跨请求共享内存或真实等待一分钟。 */
it("跨过原租期时，活跃任务已续租且不会被并行调用抢占", async () => {
  let now = epoch;
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  let advanced = false;
  await using fixture = await createWorkerFixture({ bindings: {
    ENCRYPTION_KEY: "cron-test", CRON_SECRET: "cron-test-secret", now: () => now,
    fetch: async (input) => {
      if (new URL(String(input)).pathname === "/a") {
        if (!advanced) now += 70_000;
        advanced = true;
      } else {
        entered.resolve();
        await proceed.promise;
      }
      return new Response(sourceNode);
    },
  } });
  const headers = await initialize(fixture);
  const path = await create(fixture, headers, "续租", ["https://source.example/a", "https://source.example/b"]);
  now += tick;
  const running = fixture.request(subscriptionCron, cronInit);
  try {
    await entered.promise;
    now = epoch + tick + 5 * 60_000;
    expect(await (await fixture.request(subscriptionCron, cronInit)).json()).toMatchObject({ reason: "already_running" });
  } finally {
    proceed.resolve();
  }
  expect(await (await running).json()).toMatchObject({ results: { updated: 1 } });
  expect(await read(fixture, headers, path)).toMatchObject({ lastUpdatedAt: new Date(now).toISOString() });
});


/** 字节容量限制不清除现有失败状态；只有同版本进入冷却，编辑后立即恢复调度。 */
it("D1 存储容量不足不覆盖缓存、不停用，编辑后无需等待冷却结束", async () => {
  let now = epoch;
  let oversized = false;
  let calls = 0;
  const proxies = Array.from({ length: 8 }, (_, i) => ({ ...savedNode, name: `Large${i}`,
    port: 443 + i, password: "x".repeat(95_000) }));
  const huge = JSON.stringify({ proxies });
  await using fixture = await createWorkerFixture({ bindings: {
    ENCRYPTION_KEY: "cron-test", CRON_SECRET: "cron-test-secret", now: () => now,
    fetch: async () => { calls++; return new Response(oversized ? huge : null, { status: oversized ? 200 : 404 }); },
  } });
  const headers = await initialize(fixture);
  const path = await create(fixture, headers, "状态隔离", ["https://source.example/storage"], { config: { notes: "x".repeat(260_000) } });
  now += tick;
  await fixture.scheduled(configuredSchedule(subscriptionCron));
  const before = await read(fixture, headers, path);
  expect(before).toMatchObject({ lastUpdatedAt: null, autoUpdateInterval: 360, autoUpdateState: { externalFailureCount: 1 } });
  oversized = true;
  now += tick;
  expect(await (await fixture.request(subscriptionCron, cronInit)).json()).toMatchObject({ storageLimited: 1, results: { failed: 0 } });
  expect(await read(fixture, headers, path)).toEqual(before);
  const spent = calls;
  now += tick;
  await fixture.scheduled(configuredSchedule(subscriptionCron));
  expect(calls).toBe(spent);
  expect((await fixture.request(path, { method: "PUT", headers, body: JSON.stringify({ config: {} }) })).status).toBe(200);
  await fixture.scheduled(configuredSchedule(subscriptionCron));
  expect(calls).toBeGreaterThan(spent);
  expect(await read(fixture, headers, path)).toMatchObject({ lastUpdatedAt: new Date(now).toISOString(),
    autoUpdateInterval: 360, autoUpdateState: { externalFailureCount: 0 } });
});
