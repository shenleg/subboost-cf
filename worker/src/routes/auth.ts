// 管理员初始化、登录状态与供其他 Worker 路由使用的认证守卫。
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readJsonBody } from "@subboost/server-core/http";
import { Hono, type Context } from "hono";
import { ENCRYPTION_KEY_MISSING, getClientIp, getEncryptionKey, nowMs, type WorkerApp, type WorkerBindings } from "../env";
import { clearSession, issueSession, verifySession } from "../session";

/** 可暴露给 API 调用方的管理员身份，不包含密码哈希。 */
export type CurrentAdmin = { id: string; username: string };

// 保持原版的 64 KiB 认证请求体上限和最短密码要求。
const AUTH_BODY_LIMIT = 64 * 1024;
const MIN_PASSWORD_LENGTH = 10;
// ADR-0003 选择 Workerd 默认允许的最高轮数；使用原生实现避免纯 JS 哈希超限。
const PASSWORD_ROUNDS = 100_000;
// v1 持久化格式：128 位随机盐和 SHA-256 原生输出长度。
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 32;
const PASSWORD_FORMAT = `pbkdf2-sha256$v1$${PASSWORD_ROUNDS}`;
const encoder = new TextEncoder();
const adminExists = "已有管理员账号，请直接登录";
// 保留原版每 15 分钟的初始化、登录、客户端与账号组合限额。
const AUTH_RATE_WINDOW_MS = 15 * 60_000;
const SETUP_LIMIT = { scope: "admin-setup-client", max: 5, message: "Too many setup attempts. Try again later." };
const LOGIN_LIMIT = { scope: "auth-login-client", max: 30, message: "Too many login attempts. Try again later." };
const USERNAME_LIMIT = { ...LOGIN_LIMIT, scope: "auth-login-client-username", max: 8 };

function rateKey(encryptionKey: string, ...identity: string[]): string {
  // IPv4 空间太小，不能使用可离线枚举的无密钥哈希。
  return createHmac("sha256", encryptionKey).update(`subboost-worker/auth-rate/v1:${JSON.stringify(identity)}`).digest("hex");
}

async function consumeRateLimit(c: AuthContext, key: string, limit: typeof LOGIN_LIMIT) {
  const now = nowMs(c.env);
  const resetAt = (Math.floor(now / AUTH_RATE_WINDOW_MS) + 1) * AUTH_RATE_WINDOW_MS;
  // 原子计数使边缘节点共享预算。达到上限后不继续写入，也不延长窗口。
  const accepted = await c.env.DB.prepare(`
    INSERT INTO AuthRateLimit (scope, ipHash, count, resetAt) VALUES (?, ?, 1, ?)
    ON CONFLICT (scope, ipHash) DO UPDATE SET
      count = CASE WHEN AuthRateLimit.resetAt < excluded.resetAt THEN 1 ELSE AuthRateLimit.count + 1 END,
      resetAt = excluded.resetAt
    WHERE AuthRateLimit.resetAt < excluded.resetAt
       OR (AuthRateLimit.resetAt = excluded.resetAt AND AuthRateLimit.count < ?)
    RETURNING count
  `).bind(limit.scope, key, resetAt, limit.max).first();
  if (accepted) return;
  c.header("Retry-After", String(Math.ceil((resetAt - now) / 1000)));
  return apiError(c, limit.message, "RATE_LIMITED", 429);
}

type AuthContext = Context<WorkerApp>;

function apiError(c: AuthContext, error: string, code: string, status: 400 | 401 | 403 | 409 | 413 | 429 | 503) {
  return c.json({ error, code }, status);
}

function missingKey(c: AuthContext) {
  return c.json({ ...ENCRYPTION_KEY_MISSING, error: ENCRYPTION_KEY_MISSING.message }, 503);
}

function stringField(body: unknown, key: string): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

async function parseCredentials(c: AuthContext, invalidJson = "Invalid JSON body.") {
  const parsed = await readJsonBody(c.req.raw, AUTH_BODY_LIMIT);
  if (!parsed.ok) return parsed.reason === "too_large"
    ? apiError(c, "Request body is too large.", "PAYLOAD_TOO_LARGE", 413)
    : apiError(c, invalidJson, "BAD_REQUEST", 400);
  const body = parsed.value;
  return {
    username: stringField(body, "username"),
    password: stringField(body, "password"),
    passwordConfirm: stringField(body, "passwordConfirm"),
  };
}

async function derivePassword(password: string, salt: Uint8Array<ArrayBuffer>) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PASSWORD_ROUNDS }, key, PASSWORD_HASH_BYTES * 8);
  return new Uint8Array(bits);
}

async function hashPassword(password: string): Promise<string> {
  // 128 位随机盐确保相同密码也有不同哈希；格式前缀允许独立升级哈希参数。
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  const hash = await derivePassword(password, salt);
  // Workerd 与项目支持的 Node 24 都提供 btoa；后者尚无 TypedArray Base64 API。
  return `${PASSWORD_FORMAT}$${btoa(String.fromCharCode(...salt))}$${btoa(String.fromCharCode(...hash))}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, version, rounds, serializedSalt, serializedHash, extra] = stored.split("$");
  if (`${algorithm}$${version}$${rounds}` !== PASSWORD_FORMAT || !serializedSalt || !serializedHash || extra !== undefined) return false;
  let salt: Uint8Array<ArrayBuffer>, expected: Uint8Array<ArrayBuffer>;
  try {
    salt = Uint8Array.from(atob(serializedSalt), (byte) => byte.charCodeAt(0));
    expected = Uint8Array.from(atob(serializedHash), (byte) => byte.charCodeAt(0));
  } catch {
    return false;
  }
  if (salt.byteLength !== PASSWORD_SALT_BYTES || expected.byteLength !== PASSWORD_HASH_BYTES) return false;
  return timingSafeEqual(await derivePassword(password, salt), expected);
}

/**
 * 检查会话签名与 D1 吊销状态，返回数据库中的当前管理员身份。
 * @param request 可能携带 Cookie 的 HTTP 请求。
 * @param env Worker 绑定。
 * @returns 当前管理员；无会话、无效会话或已吊销时返回 `null`。
 * @throws 无法完成持久化认证检查时抛出。
 */
export async function getCurrentAdmin(request: Request, env: WorkerBindings): Promise<CurrentAdmin | null> {
  const session = await verifySession(request, env);
  if (!session) return null;
  return env.DB.prepare(`
    SELECT id, username FROM LocalAdmin WHERE id = ?
    AND NOT EXISTS (SELECT 1 FROM RevokedSession WHERE revocationKey = ?)
  `).bind(session.adminId, session.revocationKey).first<CurrentAdmin>();
}

/**
 * 验证当前管理员后执行管理路由，缺少配置或会话时提前返回契约错误。
 * @param c 当前 Hono 上下文。
 * @param handler 收到已验证管理员后执行业务的处理器。
 * @returns 处理器响应，或 401/503 认证响应。
 * @throws 业务处理器抛出的异常继续交给 Hono。
 */
export async function withCurrentAdmin(c: AuthContext, handler: (admin: CurrentAdmin) => Response | Promise<Response>): Promise<Response> {
  if (!getEncryptionKey(c.env)) return missingKey(c);
  let admin: CurrentAdmin | null;
  try {
    admin = await getCurrentAdmin(c.req.raw, c.env);
  } catch {
    return apiError(c, "Session service unavailable.", "SESSION_STORE_UNAVAILABLE", 503);
  }
  return admin ? handler(admin) : apiError(c, "Authentication required.", "UNAUTHORIZED", 401);
}

function adminRecordExists(env: WorkerBindings) {
  return env.DB.prepare("SELECT 1 FROM LocalAdmin LIMIT 1").first();
}

/** 挂在 `/api` 下的管理员初始化与会话路由。 */
export const authRoutes = new Hono<WorkerApp>()
  .post("/setup/admin", async (c) => {
    c.header("Cache-Control", "no-store");
    const key = getEncryptionKey(c.env);
    if (!key) return missingKey(c);
    // 已初始化时永久返回 409；快速读也省去已初始化实例上的密码哈希。
    if (await adminRecordExists(c.env)) return apiError(c, adminExists, "CONFLICT", 409);
    const limited = await consumeRateLimit(c, rateKey(key, getClientIp(c.req.raw)), SETUP_LIMIT);
    if (limited) return limited;
    const setupToken = c.env.LOCAL_SETUP_TOKEN;
    if (setupToken) {
      const supplied = c.req.header("X-SubBoost-Setup-Token");
      // 对定长摘要做常量时间比较，避免泄露令牌内容或长度。
      if (!supplied || !timingSafeEqual(createHash("sha256").update(supplied).digest(), createHash("sha256").update(setupToken).digest())) {
        return apiError(c, "Invalid setup token.", "FORBIDDEN", 403);
      }
    }
    const credentials = await parseCredentials(c, "请求格式有误，请刷新页面后重试");
    if (credentials instanceof Response) return credentials;
    const { username, password, passwordConfirm } = credentials;
    if (!username) return apiError(c, "请输入管理员账号", "BAD_REQUEST", 400);
    if (password.length < MIN_PASSWORD_LENGTH) return apiError(c, `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`, "BAD_REQUEST", 400);
    if (password !== passwordConfirm) return apiError(c, "两次输入的密码不一致，请重新确认", "BAD_REQUEST", 400);

    const now = nowMs(c.env);
    // 迁移中的单例唯一索引负责仲裁并发；快速读本身不提供互斥。
    const admin = await c.env.DB.prepare(`
      INSERT INTO LocalAdmin (id, username, passwordHash, createdAt, updatedAt, lastLoginAt)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id, username
    `).bind(crypto.randomUUID(), username, await hashPassword(password), now, now, now).first<CurrentAdmin>();
    if (!admin) return apiError(c, adminExists, "CONFLICT", 409);
    await issueSession(c, admin);
    return c.json({ success: true, user: admin });
  })
  .post("/auth/login", async (c) => {
    c.header("Cache-Control", "no-store");
    const key = getEncryptionKey(c.env);
    if (!key) return missingKey(c);
    const ip = getClientIp(c.req.raw);
    const limited = await consumeRateLimit(c, rateKey(key, ip), LOGIN_LIMIT);
    if (limited) return limited;
    const credentials = await parseCredentials(c);
    if (credentials instanceof Response) return credentials;
    const { username, password } = credentials;
    const invalid = () => apiError(c, "Invalid username or password.", "UNAUTHORIZED", 401);
    if (!username || !password) return invalid();
    const usernameKey = rateKey(key, ip, username.toLowerCase());
    const usernameLimited = await consumeRateLimit(c, usernameKey, USERNAME_LIMIT);
    if (usernameLimited) return usernameLimited;
    const admin = await c.env.DB.prepare("SELECT id, username, passwordHash FROM LocalAdmin WHERE username = ?")
      .bind(username).first<CurrentAdmin & { passwordHash: string }>();
    if (!admin || !await verifyPassword(password, admin.passwordHash)) return invalid();
    const now = nowMs(c.env);
    // 成功登录只清账号组合的额度；同 IP 的总额度仍防止跨账号请求消耗资源。
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE LocalAdmin SET lastLoginAt = ?, updatedAt = ? WHERE id = ?").bind(now, now, admin.id),
      c.env.DB.prepare("DELETE FROM AuthRateLimit WHERE scope = ? AND ipHash = ?").bind(USERNAME_LIMIT.scope, usernameKey),
    ]);
    const user = { id: admin.id, username: admin.username };
    await issueSession(c, user);
    return c.json({ success: true, user });
  })
  .post("/auth/logout", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!getEncryptionKey(c.env)) return missingKey(c);
    const session = await verifySession(c.req.raw, c.env);
    if (session) {
      // 必须先持久化才能清 Cookie 并报告退出成功；重复退出无需重写记录。
      try {
        await c.env.DB.prepare(`
          INSERT INTO RevokedSession (revocationKey, expiresAt, createdAt)
          VALUES (?, ?, ?) ON CONFLICT (revocationKey) DO NOTHING
        `).bind(session.revocationKey, session.expiresAt, nowMs(c.env)).run();
      } catch {
        return apiError(c, "Session service unavailable.", "SESSION_STORE_UNAVAILABLE", 503);
      }
    }
    clearSession(c);
    return c.json({ success: true });
  })
  .get("/auth/me", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!getEncryptionKey(c.env)) return missingKey(c);
    const setupRequired = !(await adminRecordExists(c.env));
    const admin = await getCurrentAdmin(c.req.raw, c.env);
    const user = admin ? await describeAdmin(c.env, admin) : null;
    return c.json({ setupRequired, setupTokenRequired: setupRequired && Boolean(c.env.LOCAL_SETUP_TOKEN), authenticated: Boolean(user), user });
  });

async function describeAdmin(env: WorkerBindings, admin: CurrentAdmin) {
  const counts = await env.DB.prepare(`
    SELECT (SELECT count(*) FROM Subscription WHERE ownerId = ?1) AS subscriptionCount,
           (SELECT count(*) FROM LocalTemplate WHERE ownerId = ?1) AS templateCount
  `).bind(admin.id).first<{ subscriptionCount: number; templateCount: number }>();
  const now = new Date(nowMs(env)).toISOString();
  return {
    ...admin, name: admin.username, avatarUrl: null,
    trustLevel: 4, aiAssistantEnabled: false, isAdmin: false, isBanned: false,
    active: true, silenced: false, saveRequirementSatisfied: true, saveRequirementSatisfiedAt: now,
    createdAt: now, updatedAt: now, accounts: [],
    quota: { maxSubscriptions: 9999, maxNodesPerSubscription: 10000, maxCustomTemplates: 9999,
      maxImportSourcesPerType: 9999, canUseSubscriptionLink: true },
    ...counts,
  };
}
