// 使用真实生产构建和 Chromium，在同源 HTTP 接缝替换并行开发的 Worker API。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { preview } from "vite";

let server;
let origin;
let browser;

const adminAuth = {
  authenticated: true,
  setupRequired: false,
  setupTokenRequired: false,
  user: {
    username: "测试管理员",
    isAdmin: true,
    quota: { maxSubscriptions: 10, canUseSubscriptionLink: true },
    subscriptionCount: 1,
  },
};

before(async () => {
  server = await preview({ preview: { host: "127.0.0.1", port: 0 } });
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

/**
 * 用独立浏览器页面运行生产 SPA；未声明的 API 请求视为客户端契约错误。
 * @param overrides 当前场景的 HTTP 路由替身，键为方法及路径（不含查询参数）。
 * @param run 在页面上执行浏览器断言。
 * @returns 页面断言及兜底 API 检查完成后结束。
 * @throws 浏览器、断言或未覆盖的 API 请求失败时抛出。
 */
async function withPage(overrides, run) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const unexpected = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const routes = {
    "GET /api/auth/me": { authenticated: false, setupRequired: false, setupTokenRequired: false, user: null },
    "GET /api/releases/latest": { hasUpdate: false },
    "GET /api/templates": { templates: [] },
    "GET /api/subscriptions": { subscriptions: [] },
    ...overrides,
  };
  await page.route(`${origin}/api/**`, async (route) => {
    const request = route.request();
    const key = `${request.method()} ${new URL(request.url()).pathname}`;
    const handler = routes[key];
    if (typeof handler === "function") return handler(route);
    if (handler) return route.fulfill({ json: handler });
    unexpected.push(key);
    return route.fulfill({ status: 404, json: { error: "Unexpected API request" } });
  });
  try {
    await run(page);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } catch (error) {
    if (errors.length > 0) throw new Error(errors.join("\n"), { cause: error });
    throw error;
  } finally {
    await page.close();
  }
}

/** 生产入口直接访问时渲染原版转换器。 */
test("首页挂载转换器", async () => {
  await withPage({}, async (page) => {
    const response = await page.goto(origin);
    assert.equal(response.status(), 200);
    await page.getByRole("heading", { name: "SubBoost", exact: true }).waitFor({ timeout: 5000 });
    const logo = page.locator("header").getByRole("img", { name: "SubBoost" });
    assert.ok(await logo.evaluate((img) => img.complete && img.naturalWidth > 0));
  });
});

/** 已部署的仪表盘可直接打开并保留匿名登录门槛。 */
test("仪表盘在未登录时保留登录入口", async () => {
  await withPage({}, async (page) => {
    assert.equal((await page.goto(`${origin}/dashboard`)).status(), 200);
    await page.getByRole("heading", { name: "请先登录" }).waitFor({ timeout: 5000 });
    assert.equal(await page.getByRole("main").getByRole("link", { name: "登录" }).getAttribute("href"), "/login");
  });
});

/** 模板页既支持直接访问也支持客户端路由，发布徽章保留上游链接。 */
test("模板库路由、站内导航和新版本徽章", async () => {
  const releaseUrl = "https://github.com/example/subboost/releases/tag/v3.0.0";
  await withPage({
    "GET /api/releases/latest": { hasUpdate: true, latestTag: "v3.0.0", releaseUrl },
  }, async (page) => {
    assert.equal((await page.goto(`${origin}/templates`)).status(), 200);
    await page.getByRole("heading", { name: "模板库" }).waitFor({ timeout: 5000 });
    assert.equal(await page.getByRole("link", { name: "SubBoost v3.0.0 已发布" }).getAttribute("href"), releaseUrl);
    const documentRequests = [];
    page.on("request", (request) => {
      if (request.resourceType() === "document") documentRequests.push(request.url());
    });
    await page.locator("header nav").getByRole("link", { name: "首页" }).click();
    await page.waitForURL(`${origin}/`);
    await page.getByRole("heading", { name: "SubBoost", exact: true }).waitFor({ timeout: 5000 });
    assert.deepEqual(documentRequests, []);
  });
});

/** 没配置令牌也能创建管理员，且仅发送认证契约需要的数据。 */
test("没有设置 LOCAL_SETUP_TOKEN 时可完成初始化", async () => {
  let initialized = false;
  let submitted;
  await withPage({
    "GET /api/auth/me": (route) => route.fulfill({ json: initialized ? adminAuth : {
      authenticated: false, setupRequired: true, setupTokenRequired: false, user: null,
    } }),
    "POST /api/setup/admin": async (route) => {
      const request = route.request();
      submitted = { body: request.postDataJSON(), token: request.headers()["x-subboost-setup-token"] };
      initialized = true;
      await route.fulfill({ status: 201, json: { ok: true } });
    },
  }, async (page) => {
    assert.equal((await page.goto(`${origin}/login`)).status(), 200);
    await page.getByLabel("管理员账号").fill("admin");
    await page.getByLabel("密码", { exact: true }).fill("first-password");
    await page.getByLabel("确认密码").fill("first-password");
    assert.equal(await page.getByLabel("初始化令牌").count(), 0);
    await page.getByRole("button", { name: "创建管理员" }).click();
    await page.waitForURL(`${origin}/dashboard`);
    assert.deepEqual(submitted, {
      body: { username: "admin", password: "first-password", passwordConfirm: "first-password" },
      token: undefined,
    });
  });
});

/** 配置了令牌才显示令牌输入，并只用请求头传递该值。 */
test("配置 LOCAL_SETUP_TOKEN 后要求输入令牌", async () => {
  let initialized = false;
  let submitted;
  await withPage({
    "GET /api/auth/me": (route) => route.fulfill({ json: initialized ? adminAuth : {
      authenticated: false, setupRequired: true, setupTokenRequired: true, user: null,
    } }),
    "POST /api/setup/admin": async (route) => {
      const request = route.request();
      submitted = { body: request.postDataJSON(), token: request.headers()["x-subboost-setup-token"] };
      initialized = true;
      await route.fulfill({ status: 201, json: { ok: true } });
    },
  }, async (page) => {
    await page.goto(`${origin}/login`);
    await page.getByLabel("管理员账号").fill("admin");
    await page.getByLabel("密码", { exact: true }).fill("first-password");
    await page.getByLabel("确认密码").fill("first-password");
    const submit = page.getByRole("button", { name: "创建管理员" });
    assert.ok(await submit.isDisabled());
    await page.getByLabel("初始化令牌").fill("configured-setup-token");
    await submit.click();
    await page.waitForURL(`${origin}/dashboard`);
    assert.deepEqual(submitted, {
      body: { username: "admin", password: "first-password", passwordConfirm: "first-password" },
      token: "configured-setup-token",
    });
  });
});

/** 缺少密钥时首页提供引导，登录页不呈现无法提交的凭据表单。 */
test("站点与登录页显示 Cloudflare 密钥配置指引", async () => {
  const message = "请在 Cloudflare Dashboard 的 Workers 和 Pages 中选择此 Worker，打开「设置 → 变量和机密」，添加 ENCRYPTION_KEY。";
  await withPage({
    "GET /api/auth/me": (route) => route.fulfill({
      status: 503,
      json: { authenticated: false, user: null, code: "ENCRYPTION_KEY_MISSING", message },
    }),
  }, async (page) => {
    await page.goto(origin);
    await page.getByRole("alert").filter({ hasText: message }).waitFor();
    await page.goto(`${origin}/login`);
    await page.getByRole("alert").filter({ hasText: message }).waitFor();
    assert.equal(await page.getByLabel("管理员账号").count(), 0);
    assert.equal(await page.getByRole("button", { name: "创建管理员" }).count(), 0);
  });
});

/** 账户页展示真实云端网络边界，不展示能访问本机的误导性开关。 */
test("账户设置显示配额、同源运行端点和 Cloudflare 局域网边界", async () => {
  await withPage({ "GET /api/auth/me": adminAuth }, async (page) => {
    assert.equal((await page.goto(`${origin}/dashboard/settings`)).status(), 200);
    await page.getByRole("heading", { name: "账户设置" }).waitFor();
    const main = page.getByRole("main");
    await main.getByText("测试管理员", { exact: true }).waitFor();
    await main.getByText("1 / 10", { exact: true }).waitFor();
    await main.getByText(/Cloudflare 边缘节点无法访问.*局域网/).waitFor();
    assert.equal(await main.getByRole("switch", { name: /允许本机和局域网/ }).count(), 0);
    const ready = main.getByRole("link", { name: "/api/health/ready" });
    assert.equal(await ready.evaluate((link) => link.href), `${origin}/api/health/ready`);
  });
});

/** 原版订阅下载使用当前站点，后端配置的发布域名不会成为浏览器跨域请求。 */
test("通过当前访问域名下载订阅配置", async () => {
  const path = "/api/subscriptions/subscription-token/config.yaml";
  await withPage({
    "GET /api/auth/me": adminAuth,
    "GET /api/subscriptions": {
      subscriptions: [{
        id: "s1", name: "测试订阅", token: "subscription-token", createdAt: "2025-01-01T00:00:00Z",
        subscriptionUrl: `https://alternate.example.invalid${path}?format=yaml`,
        autoUpdateState: { disabledAt: null, nodeQuotaFailureCount: 0 },
      }],
    },
    [`GET ${path}`]: (route) => route.fulfill({ contentType: "application/yaml", body: "proxies: []\n" }),
  }, async (page) => {
    await page.goto(`${origin}/dashboard`);
    await page.getByRole("heading", { name: "我的订阅" }).waitFor();
    const request = page.waitForRequest(`${origin}${path}?format=yaml`);
    const download = page.waitForEvent("download");
    await page.getByTitle("下载订阅配置").click();
    assert.equal((await request).method(), "GET");
    assert.match((await download).suggestedFilename(), /\.yaml$/);
  });
});

/** Worker 适配器紧接 pending 继续请求，同一次点击只在终态报告成功。 */
test("一次点击完成需要接续的订阅刷新", async () => {
  const requests = [];
  await withPage({
    "GET /api/auth/me": adminAuth,
    "GET /api/subscriptions": { subscriptions: [{
      id: "s1", name: "测试订阅", token: "token", subscriptionUrl: `${origin}/api/subscriptions/token/config.yaml`,
      createdAt: "2025-01-01T00:00:00Z", autoUpdateState: { disabledAt: null, nodeQuotaFailureCount: 0 },
    }] },
    "POST /api/subscriptions/s1/refresh": (route) => {
      requests.push(route.request().headers()["x-subboost-refresh-continuation"]);
      return requests.length === 1
        ? route.fulfill({ status: 202, json: { code: "SUBSCRIPTION_REFRESH_PENDING", continuation: "fixture-next" } })
        : route.fulfill({ json: { success: true, refreshableSourceCount: 18, refreshedSourceCount: 18,
          nodeCount: 20, attemptedUrlFetch: true } });
    },
  }, async (page) => {
    await page.goto(`${origin}/dashboard`);
    await page.getByTitle("重新生成配置并刷新缓存").click();
    await page.getByText("刷新完成：18 个源已更新，共 20 个节点").waitFor();
    assert.deepEqual(requests, [undefined, "fixture-next"]);
  });
});

/** 模板深链接通过查询参数打开上传界面，并以 replace 消费参数。 */
test("模板上传深链接消费查询参数，不重新加载页面", async () => {
  await withPage({ "GET /api/auth/me": adminAuth }, async (page) => {
    await page.goto(`${origin}/templates?upload=1`);
    await page.getByRole("dialog").waitFor();
    await page.waitForURL(`${origin}/templates`);
    assert.equal(await page.evaluate(() => performance.getEntriesByType("navigation")[0].name), `${origin}/templates?upload=1`);
  });
});

/** 已初始化的实例走登录端点，不会误发片段中的初始化令牌。 */
test("现有管理员通过同源认证接口登录", async () => {
  let signedIn = false;
  let submitted;
  await withPage({
    "GET /api/auth/me": (route) => route.fulfill({ json: signedIn ? adminAuth : {
      authenticated: false, setupRequired: false, setupTokenRequired: false, user: null,
    } }),
    "POST /api/auth/login": async (route) => {
      const request = route.request();
      submitted = { body: request.postDataJSON(), token: request.headers()["x-subboost-setup-token"] };
      signedIn = true;
      await route.fulfill({ json: { ok: true } });
    },
  }, async (page) => {
    await page.goto(`${origin}/login#setup-token=unused-fragment`);
    await page.getByLabel("管理员账号").fill("admin");
    await page.getByLabel("密码", { exact: true }).fill("first-password");
    assert.equal(await page.getByLabel("确认密码").count(), 0);
    await page.getByRole("main").getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL(`${origin}/dashboard`);
    assert.equal(submitted.body.username, "admin");
    assert.equal(submitted.body.password, "first-password");
    assert.equal(submitted.token, undefined);
  });
});
