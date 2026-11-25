// 签发和核验 Worker 管理员会话，独立于具体 Hono 路由。
import { deriveSessionRevocationIdentity } from "@subboost/server-core/session-revocation";
import { errors, jwtVerify, SignJWT } from "jose";
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { parse as parseCookies } from "hono/utils/cookie";
import { getEncryptionKey, getSiteOrigin, nowMs, type WorkerApp, type WorkerBindings } from "./env";

const COOKIE = "subboost_local_session";
const ISSUER = "subboost-worker";
// Cookie 和 JWT 共用七天有效期，避免浏览器比签名会话多保留或提前丢弃凭据。
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();

type SessionIdentity = { id: string; username: string };

async function signingKey(env: WorkerBindings): Promise<Uint8Array> {
  if (env.JWT_SECRET?.trim()) return encoder.encode(env.JWT_SECRET.trim());
  const key = getEncryptionKey(env);
  if (!key) throw new Error("ENCRYPTION_KEY_MISSING");
  // 显式分域，避免拿业务字段的加密材料直接签名。
  const source = await crypto.subtle.importKey("raw", encoder.encode(key), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(),
    info: encoder.encode("subboost-worker/session-signing/hs256/v1") }, source, 256);
  return new Uint8Array(bits);
}

/**
 * 为已验证的管理员签发同源七天会话 Cookie。
 * @param c 当前 HTTP 上下文。
 * @param admin 会话所有者。
 * @returns Cookie 写入响应头后的完成信号。
 * @throws 缺失签名配置或签名失败时抛出。
 */
export async function issueSession(c: Context<WorkerApp>, admin: SessionIdentity) {
  const issued = Math.floor(nowMs(c.env) / 1000);
  const token = await new SignJWT({ username: admin.username })
    .setProtectedHeader({ alg: "HS256" }).setIssuer(ISSUER).setSubject(admin.id)
    .setIssuedAt(issued).setJti(crypto.randomUUID()).setExpirationTime(issued + MAX_AGE_SECONDS)
    .sign(await signingKey(c.env));
  writeCookie(c, token, MAX_AGE_SECONDS);
}

/**
 * 清除与签发时作用域相同的会话 Cookie，不修改 D1 吊销记录。
 * @param c 当前 HTTP 上下文。
 * @returns 无；响应将带过期 Cookie。
 */
export function clearSession(c: Context<WorkerApp>): void {
  writeCookie(c, "", 0);
}

function writeCookie(c: Context<WorkerApp>, token: string, maxAge: number) {
  setCookie(c, COOKIE, token, {
    path: "/", httpOnly: true, sameSite: "Lax", maxAge,
    secure: getSiteOrigin(c.req.raw, c.env).startsWith("https://"),
  });
}

/**
 * 验证请求 Cookie 的签名、发行方和时效；不检查持久化吊销状态。
 * @param request 可能携带会话 Cookie 的 HTTP 请求。
 * @param env 用于签名密钥和当前时间的绑定。
 * @returns 管理员 ID 和吊销标识；无有效会话时返回 `null`。
 * @throws 密钥派生等运行时异常会传播；无效 Token 不抛异常。
 */
export async function verifySession(request: Request, env: WorkerBindings) {
  if (!getEncryptionKey(env)) return null;
  // Cookie 解析只依赖请求头；守卫不要求调用方持有 Hono 上下文。
  const token = parseCookies(request.headers.get("Cookie") ?? "", COOKIE)[COOKIE];
  if (!token) return null;
  const key = await signingKey(env);
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"], issuer: ISSUER, requiredClaims: ["sub", "exp", "jti"],
      currentDate: new Date(nowMs(env)),
    });
    if (typeof payload.sub !== "string" || !payload.sub || typeof payload.jti !== "string" || !payload.jti ||
        typeof payload.username !== "string" || !payload.username || !Number.isSafeInteger(payload.exp)) return null;
    const identity = deriveSessionRevocationIdentity({ namespace: ISSUER, token, claims: payload, clockToleranceSeconds: 0 });
    return { adminId: payload.sub, revocationKey: identity.key, expiresAt: identity.expiresAt.getTime() };
  } catch (error) {
    if (error instanceof errors.JOSEError) return null;
    throw error;
  }
}
