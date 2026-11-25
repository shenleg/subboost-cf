// 通过 Worker 顶层 HTTP 入口验证版本检查契约。
import { expect, it, vi } from "vitest";
import { version } from "../../package.json";
import { createWorkerFixture } from "./fixture";

const path = "/api/releases/latest";
const cacheControl = "public, max-age=3600, stale-while-revalidate=3600";

/** 验证无需登录即可用根包版本和上游稳定版进行数字比较，并保留缓存契约。 */
it("对比上游最新稳定版并返回缓存头", async () => {
  const url = "https://github.com/SubBoost/subboost/releases/tag/v9999.10.0";
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ tag_name: "v9999.10.0", html_url: url }));
  await using fixture = await createWorkerFixture({ bindings: { fetch }, migrate: false });
  const response = await fixture.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe(cacheControl);
  await expect(response.json()).resolves.toEqual({
    currentVersion: version, latestVersion: "9999.10.0", latestTag: "v9999.10.0", releaseUrl: url, hasUpdate: true,
  });
  expect(fetch).toHaveBeenCalledWith("https://api.github.com/repos/SubBoost/subboost/releases/latest", expect.objectContaining({
    headers: expect.objectContaining({ Accept: "application/vnd.github+json" }),
    cf: expect.objectContaining({ cacheTtlByStatus: { "200-299": 3600, "300-599": -1 } }),
  }));
});

/** 验证仓库覆盖只能使用规范的 owner/repo，不会更改主机或 URL 结构。 */
it("接受合法仓库覆盖，无效仓库回退默认上游", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ tag_name: "1.99.99" }));
  await using fixture = await createWorkerFixture({ bindings: { fetch, RELEASE_REPO: "my-org/worker.release_test" }, migrate: false });
  const response = await fixture.request(path);
  await expect(response.json()).resolves.toEqual({
    currentVersion: version, latestVersion: "1.99.99", latestTag: "1.99.99",
    releaseUrl: "https://github.com/my-org/worker.release_test/releases/tag/1.99.99", hasUpdate: false,
  });
  expect(fetch.mock.lastCall?.[0]).toBe("https://api.github.com/repos/my-org/worker.release_test/releases/latest");
  for (const malformed of ["", " owner/repo", "owner/repo\n", "https://github.com/a/b", "owner/..", "a/b/c", "a%2Fb/repo", "a/b?x=y", "-owner/repo", "owner/repo#fragment", "owner\\name/repo"]) {
    fixture.env.RELEASE_REPO = malformed;
    expect((await fixture.request(path)).status).toBe(200);
    expect(fetch.mock.lastCall?.[0]).toBe("https://api.github.com/repos/SubBoost/subboost/releases/latest");
  }
});

/** 验证 GitHub 回源故障或不稳定响应不会出现错误更新提示。 */
it("回源失败或没有稳定发布时保留缓存并返回空最新版本", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  await using fixture = await createWorkerFixture({ bindings: { fetch }, migrate: false });
  fetch.mockRejectedValueOnce(new Error("GitHub unavailable"))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response("{invalid json"))
    .mockResolvedValueOnce(Response.json({ tag_name: 123 }))
    .mockResolvedValueOnce(Response.json({ tag_name: "v9999.0.0-rc.1" }))
    .mockResolvedValueOnce(Response.json({ tag_name: "v9999.0.0", prerelease: true }))
    .mockResolvedValueOnce(Response.json({ tag_name: "v9999.0.0", draft: true }));
  for (let attempt = 0; attempt < 7; attempt++) {
    const response = await fixture.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(cacheControl);
    await expect(response.json()).resolves.toEqual({
      currentVersion: version, latestVersion: null, latestTag: null, releaseUrl: null, hasUpdate: false,
    });
  }
});

/** 验证更新链接仅指向所配置仓库的对应 GitHub 发布页。 */
it("GitHub 返回无法使用的发布链接时回退到规范链接", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  await using fixture = await createWorkerFixture({ bindings: { fetch }, migrate: false });
  for (const html_url of [null, 123, "https://example.org/v9999.0.0", "https://github.com/Other/other/releases/tag/v9999.0.0"]) {
    fetch.mockResolvedValueOnce(Response.json({ tag_name: "v9999.0.0", html_url }));
    const response = await fixture.request(path);
    await expect(response.json()).resolves.toMatchObject({
      latestVersion: "9999.0.0", hasUpdate: true, releaseUrl: "https://github.com/SubBoost/subboost/releases/tag/v9999.0.0",
    });
  }
});
