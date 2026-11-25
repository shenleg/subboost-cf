// 通过 Worker 顶层 HTTP 入口验证模板库契约。
import { expect, it } from "vitest";
import { createWorkerFixture } from "./fixture";

/** 验证匿名用户可浏览和应用内置模板，且仅支持原版的模板分类。 */
it("公开提供内置模板列表和可应用的配置", async () => {
  await using fixture = await createWorkerFixture();
  const all = await fixture.request("/api/templates");
  expect(all.status).toBe(200);
  await expect(all.json()).resolves.toMatchObject({
    templates: ["minimal", "standard", "full"].map((type) => ({
      id: `builtin-${type}`, isOfficial: true, isPublic: true,
    })),
    pagination: { page: 1, limit: 3, total: 3, totalPages: 1 },
  });

  const filtered = await fixture.request("/api/templates?type=default&ids=%20builtin-minimal,builtin-minimal,missing");
  await expect(filtered.json()).resolves.toMatchObject({
    templates: [{ id: "builtin-minimal" }],
    pagination: { page: 1, limit: 1, total: 1, totalPages: 1 },
  });

  const detail = await fixture.request("/api/templates/builtin-minimal");
  expect(detail.status).toBe(200);
  await expect(detail.json()).resolves.toMatchObject({
    template: { id: "builtin-minimal", kind: "config", config: { schema: "subboost-template-config/v1" } },
  });
  const invalid = await fixture.request("/api/templates?type=plaza");
  expect(invalid.status).toBe(400);
  await expect(invalid.json()).resolves.toMatchObject({ code: "VALIDATION_ERROR" });
});

/** 验证管理员可管理加密模板，匿名调用不能读取或写入私有模板。 */
it("上传、筛选、读取和删除私有模板都要求管理员会话", async () => {
  const key = "fixture-template-key";
  await using fixture = await createWorkerFixture({ bindings: {
    ENCRYPTION_KEY: key, JWT_SECRET: "fixture-independent-session-key", now: () => 1_800_000_000_000,
  } });
  const setup = await fixture.request("/api/setup/admin", {
    method: "POST",
    body: JSON.stringify({ username: "admin", password: "fixture-password", passwordConfirm: "fixture-password" }),
  });
  expect(setup.status).toBe(200);
  const cookie = setup.headers.get("Set-Cookie")?.split(";")[0];
  expect(cookie).toBeTruthy();
  const headers = { Cookie: cookie! };
  const builtin = await fixture.request("/api/templates/builtin-minimal");
  const { template: { config } } = await builtin.json<{ template: { config: unknown } }>();
  const upload = { method: "POST", body: JSON.stringify({ name: " 私有模板 ", description: " 描述 ", config }) };

  const unauthorizedUpload = await fixture.request("/api/templates", upload);
  expect(unauthorizedUpload.status).toBe(401);
  const created = await fixture.request("/api/templates", { ...upload, headers });
  expect(created.status).toBe(201);
  const { template } = await created.json<{ template: { id: string } }>();
  expect(template).toEqual({
    id: expect.any(String), name: "私有模板", description: "描述", createdAt: "2027-01-15T08:00:00.000Z",
    downloads: 0, engagementCount: 0, tags: ["本地"], isOfficial: false, isPublic: false, isOwner: true,
    proxyGroupCount: expect.any(Number), ruleCount: expect.any(Number),
  });

  const path = `/api/templates/${template.id}`;
  const deletePath = `/api/templates?id=${template.id}`;
  for (const denied of [
    await fixture.request("/api/templates?type=my"),
    await fixture.request(path),
    await fixture.request(deletePath, { method: "DELETE" }),
  ]) {
    expect(denied.status).toBe(401);
    await expect(denied.json()).resolves.toMatchObject({ code: "UNAUTHORIZED" });
  }
  const list = await fixture.request(`/api/templates?type=my&ids=missing,${template.id}`, { headers });
  await expect(list.json()).resolves.toEqual({
    templates: [template], pagination: { page: 1, limit: 1, total: 1, totalPages: 1 },
  });
  const detail = await fixture.request(path, { headers });
  await expect(detail.json()).resolves.toEqual({
    template: { id: template.id, name: "私有模板", description: "描述", kind: "config", config },
  });

  // 独立会话密钥使更换数据密钥后会话仍有效，但已保存正文不应被解出。
  fixture.env.ENCRYPTION_KEY = "different-template-key";
  const wrongKey = await fixture.request(path, { headers });
  expect(wrongKey.status).toBe(400);
  await expect(wrongKey.json()).resolves.toMatchObject({ code: "BAD_REQUEST" });
  fixture.env.ENCRYPTION_KEY = key;

  const deleted = await fixture.request(deletePath, { method: "DELETE", headers });
  await expect(deleted.json()).resolves.toEqual({ success: true });
  expect((await fixture.request(path, { headers })).status).toBe(404);
  expect((await fixture.request(deletePath, { method: "DELETE", headers })).status).toBe(404);
});

/** 验证上传拒绝非法正文且不写入 D1，内置模板也不能被删除。 */
it("限制上传体积并用上游模板校验拒绝非法配置", async () => {
  await using fixture = await createWorkerFixture({ bindings: { ENCRYPTION_KEY: "fixture-template-key" } });
  const setup = await fixture.request("/api/setup/admin", {
    method: "POST",
    body: JSON.stringify({ username: "admin", password: "fixture-password", passwordConfirm: "fixture-password" }),
  });
  expect(setup.status).toBe(200);
  const headers = { Cookie: setup.headers.get("Set-Cookie")!.split(";")[0] };
  for (const body of ["{", "[]", JSON.stringify({ name: " ", config: {} }), JSON.stringify({ name: "测试", config: {} })]) {
    const response = await fixture.request("/api/templates", { method: "POST", headers, body });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "BAD_REQUEST" });
  }
  const oversized = await fixture.request("/api/templates", {
    method: "POST", headers, body: JSON.stringify({ name: "大模板", config: "中".repeat(1_400_000) }),
  });
  expect(oversized.status).toBe(413);
  await expect(oversized.json()).resolves.toEqual({ error: "Request body is too large.", code: "PAYLOAD_TOO_LARGE" });
  const list = await fixture.request("/api/templates?type=my", { headers });
  await expect(list.json()).resolves.toEqual({
    templates: [], pagination: { page: 1, limit: 0, total: 0, totalPages: 1 },
  });
  expect((await fixture.request("/api/templates?id=builtin-minimal", { method: "DELETE", headers })).status).toBe(404);
  expect((await fixture.request("/api/templates", { method: "DELETE", headers })).status).toBe(400);
});

/** 请求仍小于 4 MiB 时，按加密后整行的实际 UTF-8 字节限制保存。 */
it("加密后过大的模板返回 413，且不写入模板库", async () => {
  await using fixture = await createWorkerFixture({ bindings: { ENCRYPTION_KEY: "fixture-template-key" } });
  const setup = await fixture.request("/api/setup/admin", {
    method: "POST",
    body: JSON.stringify({ username: "admin", password: "fixture-password", passwordConfirm: "fixture-password" }),
  });
  expect(setup.status).toBe(200);
  const headers = { Cookie: setup.headers.get("Set-Cookie")!.split(";")[0] };
  const builtin = await fixture.request("/api/templates/builtin-minimal");
  const { template: { config } } = await builtin.json<{ template: { config: object } }>();
  const upload = (name: string, length: number) => fixture.request("/api/templates", { method: "POST", headers,
    body: JSON.stringify({ name, config: { ...config, customProxyGroups: [
      { id: "test", name: "测试组", emoji: "", groupType: "select", description: "中".repeat(length) },
    ] } }) });

  expect((await upload("可保存", 320_000)).status).toBe(201);
  const oversized = await upload("超过存储上限", 340_000);
  expect(oversized.status).toBe(413);
  await expect(oversized.json()).resolves.toMatchObject({ code: "PAYLOAD_TOO_LARGE", error: expect.stringMatching(/D1.*2 MB/) });
  const list = await fixture.request("/api/templates?type=my", { headers });
  const { templates } = await list.json<{ templates: { name: string }[] }>();
  expect(templates.map(({ name }) => name)).toEqual(["可保存"]);
});
