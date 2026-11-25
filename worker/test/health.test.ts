// 验证 Worker 顶层 HTTP 健康检查契约。
import { expect, it } from "vitest";
import { createWorkerFixture } from "./fixture";

/** 存活检查不依赖数据库迁移或密钥配置。 */
it("在未迁移、未配置密钥时仍报告 Worker 存活", async () => {
  await using fixture = await createWorkerFixture({ migrate: false });
  const response = await fixture.request("/api/health/live");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, service: "subboost-worker" });
});

/** 缺失必填密钥时，就绪检查返回可供前端识别的错误和部署指引。 */
it("未配置 ENCRYPTION_KEY 时返回 503 及中文配置指引", async () => {
  await using fixture = await createWorkerFixture({ migrate: false });
  const response = await fixture.request("/api/health/ready");

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    ok: false,
    code: "ENCRYPTION_KEY_MISSING",
    message: expect.stringMatching(/Cloudflare Dashboard.*变量和机密.*ENCRYPTION_KEY/),
  });
});

/** 只配置加密密钥并迁移 D1，实例就可以接受请求。 */
it("只配置 ENCRYPTION_KEY 且 D1 已迁移时就绪", async () => {
  await using fixture = await createWorkerFixture({ bindings: { ENCRYPTION_KEY: "test-key" } });
  const response = await fixture.request("/api/health/ready");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, database: "ready" });
});

/** D1 有绑定但未迁移时，不能把实例误报为就绪或泄漏数据库错误。 */
it("配置密钥但未迁移 D1 时返回 503", async () => {
  await using fixture = await createWorkerFixture({
    bindings: { ENCRYPTION_KEY: "test-key" },
    migrate: false,
  });
  const response = await fixture.request("/api/health/ready");

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ok: false, database: "unavailable" });
});

/** 在初始迁移已完成但缺少刷新运行表时拒绝报告就绪。 */
it.each([1, 2])("配置密钥但仅应用前 %i 份迁移时返回 503", async (count) => {
  await using fixture = await createWorkerFixture({ bindings: { ENCRYPTION_KEY: "test-key" }, migrate: count });
  const response = await fixture.request("/api/health/ready");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ok: false, database: "unavailable" });
});
