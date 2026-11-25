// 将订阅快照、令牌及自动更新状态映射到 D1；业务序列化留给共享核心。
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import type { ParsedNode } from "@subboost/core/types/node";
import { decryptEncryptedFieldV2, encryptEncryptedFieldV2 } from "@subboost/server-core/crypto";
import {
  normalizeSubscriptionInfoForPersistence,
  type PreparedRefreshCacheSnapshot,
  type SubscriptionAutoUpdateStateFields,
  type SubscriptionSummaryDataSource,
} from "@subboost/server-core/subscription";

type EncryptedFields = {
  encryptedUrls: string;
  encryptedNodes: string;
  encryptedConfig: string;
  encryptedSubscriptionInfo: string | null;
};

/** 供管理、公开分发和刷新使用的版本化订阅；日期已从 D1 毫秒解码。 */
export type SubscriptionRow = SubscriptionSummaryDataSource & EncryptedFields & {
  ownerId: string;
  revision: string;
  autoUpdateInterval: number | null;
  autoUpdateState: SubscriptionAutoUpdateStateFields | null;
  createdAt: Date;
  updatedAt: Date;
  lastUpdatedAt: Date | null;
  lastAccessedAt: Date | null;
  cacheExpiresAt: Date | null;
};

/** 完整解密的订阅快照，不包含令牌与持久化版本。 */
export type SubscriptionSecrets = {
  urls: string[];
  nodes: ParsedNode[];
  config: Record<string, unknown>;
  subscriptionInfo: Record<string, unknown>;
};

type StateDates = "lastAttemptedAt" | "lastFailedAt" | "lastNodeQuotaExceededAt" | "disabledAt";
type StoredState = Omit<SubscriptionAutoUpdateStateFields, StateDates> & Record<StateDates, number | null>;
type StoredRow = Omit<SubscriptionRow, "isPrimary" | "autoUpdateState" | "createdAt" | "updatedAt" | "lastUpdatedAt" | "lastAccessedAt" | "cacheExpiresAt"> & {
  isPrimary: number;
  stateId: string | null;
  createdAt: number;
  updatedAt: number;
  lastUpdatedAt: number | null;
  lastAccessedAt: number | null;
  cacheExpiresAt: number | null;
} & StoredState;

const fields = ["externalFailureCount", "failureSourceState", "lastFailedAt", "lastAttemptedAt",
  "nodeQuotaFailureCount", "lastNodeQuotaExceededAt", "lastNodeQuotaActual", "lastNodeQuotaLimit",
  "disabledAt", "disabledReason", "disabledPreviousInterval"] as const satisfies readonly (keyof SubscriptionAutoUpdateStateFields)[];
const select = `SELECT s.*, a.subscriptionId AS stateId, ${fields.map((key) => `a.${key}`).join(", ")}
  FROM Subscription s LEFT JOIN SubscriptionAutoUpdateState a ON a.subscriptionId = s.id`;
// D1 限制的是整行序列化后的 2,000,000 字节；为 SQLite 记录头、定长令牌与整数元数据保留空间。
const D1_ROW_BYTES = 2_000_000;
const ROW_OVERHEAD_BYTES = 256;

/** 订阅快照或刷新状态超过 D1 整行上限；不能当作远程来源或节点配额失败。 */
export class SubscriptionStorageLimitError extends Error {
  /** 构造不会暴露快照内容的容量错误；无参数，不抛异常。 */
  constructor() {
    super("订阅加密后超过 Cloudflare D1 单行存储上限（2 MB），请减少节点或配置大小。");
    this.name = "SubscriptionStorageLimitError";
  }
}

function checkRowSize(values: readonly (string | number | Date | null)[]) {
  let bytes = ROW_OVERHEAD_BYTES;
  for (const value of values) {
    if (typeof value === "string") bytes += Buffer.byteLength(value);
    if (bytes > D1_ROW_BYTES) throw new SubscriptionStorageLimitError();
  }
}

function assertFits(row: EncryptedFields & { id: string; ownerId: string; name: string }) {
  // 四列都是 ASCII v2 密文；仅对非密文字段计算 UTF-8 字节数。
  const ciphertextBytes = row.encryptedUrls.length + row.encryptedNodes.length + row.encryptedConfig.length +
    (row.encryptedSubscriptionInfo?.length ?? 0);
  if (ciphertextBytes + ROW_OVERHEAD_BYTES + Buffer.byteLength(row.id + row.ownerId + row.name) > D1_ROW_BYTES) {
    throw new SubscriptionStorageLimitError();
  }
}

function date(value: number | null) {
  return value === null ? null : new Date(value);
}

function decode(row: StoredRow): SubscriptionRow {
  const { stateId, externalFailureCount, failureSourceState, lastFailedAt, lastAttemptedAt, nodeQuotaFailureCount,
    lastNodeQuotaExceededAt, lastNodeQuotaActual, lastNodeQuotaLimit, disabledAt, disabledReason, disabledPreviousInterval,
    ...subscription } = row;
  return {
    ...subscription, isPrimary: row.isPrimary === 1, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt),
    lastUpdatedAt: date(row.lastUpdatedAt), lastAccessedAt: date(row.lastAccessedAt), cacheExpiresAt: date(row.cacheExpiresAt),
    autoUpdateState: stateId === null ? null : {
      externalFailureCount, failureSourceState, lastFailedAt: date(lastFailedAt), lastAttemptedAt: date(lastAttemptedAt),
      nodeQuotaFailureCount, lastNodeQuotaExceededAt: date(lastNodeQuotaExceededAt), lastNodeQuotaActual, lastNodeQuotaLimit,
      disabledAt: date(disabledAt), disabledReason, disabledPreviousInterval,
    },
  };
}

/**
 * 按管理员及 ID 读取订阅和刷新状态。
 * @param db D1 绑定。
 * @param ownerId 订阅所属管理员。
 * @param id 订阅 ID。
 * @returns 版本化订阅，找不到时为 null。
 * @throws D1 读取失败。
 */
export async function readSubscription(db: D1Database, ownerId: string, id: string) {
  const row = await db.prepare(`${select} WHERE s.ownerId = ? AND s.id = ?`).bind(ownerId, id).first<StoredRow>();
  return row && decode(row);
}

/**
 * 列出所属管理员的订阅，最近写入的排在前面。
 * @param db D1 绑定。
 * @param ownerId 订阅所属管理员。
 * @returns 订阅和关联刷新状态。
 * @throws D1 读取失败。
 */
export async function listSubscriptions(db: D1Database, ownerId: string) {
  const { results } = await db.prepare(`${select} WHERE s.ownerId = ? ORDER BY s.updatedAt DESC, s.id`).bind(ownerId).all<StoredRow>();
  return results.map(decode);
}

/**
 * 从 D1 主库读取公开快照，不写访问时间、不复用令牌查询结果。
 * @param db D1 绑定（不启用读副本 Session）。
 * @param token 公开下载令牌。
 * @returns 分发需要的最小记录，令牌无效时为 null。
 * @throws D1 读取失败。
 */
export function readPublicSubscription(db: D1Database, token: string) {
  return db.prepare(`SELECT name, autoUpdateInterval, encryptedUrls, encryptedNodes, encryptedConfig,
    encryptedSubscriptionInfo FROM Subscription WHERE token = ?`).bind(token)
    .first<EncryptedFields & { name: string; autoUpdateInterval: number | null }>();
}

function encrypt(value: unknown, key: string) {
  const plaintext = JSON.stringify(value);
  // v2 是十六进制；超过半行的单字段必然不可保存，避免为它分配更大的密文。
  if (Buffer.byteLength(plaintext) * 2 > D1_ROW_BYTES) throw new SubscriptionStorageLimitError();
  return encryptEncryptedFieldV2(plaintext, key);
}

function decrypt<T>(value: string, key: string): T {
  return JSON.parse(decryptEncryptedFieldV2(value, key)) as T;
}

/**
 * 解密持久化的业务快照，不混入订阅所有权和令牌。
 * @param row 版本化订阅。
 * @param key 当前加密密钥。
 * @returns 解密的 URL、节点、配置和流量信息。
 * @throws 密文无效、密钥不匹配或存储 JSON 无效。
 */
export function readSubscriptionSecrets(row: EncryptedFields, key: string): SubscriptionSecrets {
  return {
    urls: decrypt(row.encryptedUrls, key), nodes: decrypt(row.encryptedNodes, key), config: decrypt(row.encryptedConfig, key),
    subscriptionInfo: normalizeSubscriptionInfoForPersistence(row.encryptedSubscriptionInfo && decrypt(row.encryptedSubscriptionInfo, key)) ?? {},
  };
}

function encryptSecrets(secrets: SubscriptionSecrets, key: string): EncryptedFields {
  return {
    encryptedUrls: encrypt(secrets.urls, key), encryptedNodes: encrypt(secrets.nodes, key),
    encryptedConfig: encrypt(secrets.config, key), encryptedSubscriptionInfo: encrypt(secrets.subscriptionInfo, key),
  };
}

type SaveFields = { name: string; autoUpdateInterval: number | null; secrets: SubscriptionSecrets };

/**
 * 加密并创建一条尚未刷新过的订阅。
 * @param db D1 绑定。
 * @param input 已校验的字段、管理员、密钥和当前毫秒时间。
 * @returns 新订阅的版本化记录。
 * @throws SubscriptionStorageLimitError 加密后超出 D1 容量；D1 或加密失败也会传播。
 */
export async function insertSubscription(db: D1Database, input: SaveFields & { ownerId: string; key: string; now: number }) {
  const { ownerId, name, autoUpdateInterval, secrets, key, now } = input;
  const id = crypto.randomUUID();
  const revision = crypto.randomUUID();
  const token = randomBytes(32).toString("base64url");
  const encrypted = encryptSecrets(secrets, key);
  assertFits({ ...encrypted, id, ownerId, name });
  await db.prepare(`INSERT INTO Subscription (id, ownerId, name, token, revision, encryptedUrls, encryptedNodes,
    encryptedConfig, encryptedSubscriptionInfo, autoUpdateInterval, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, ownerId, name, token, revision, encrypted.encryptedUrls, encrypted.encryptedNodes, encrypted.encryptedConfig,
      encrypted.encryptedSubscriptionInfo, autoUpdateInterval, now, now).run();
  return { ...encrypted, id, ownerId, name, token, revision, autoUpdateInterval, isPrimary: false,
    createdAt: new Date(now), updatedAt: new Date(now), lastUpdatedAt: null, lastAccessedAt: null, cacheExpiresAt: null,
    autoUpdateState: null } satisfies SubscriptionRow;
}

/** 沿用上游成功刷新缓存的一小时有效期，也用于客户端建议刷新周期。 */
export const SUBSCRIPTION_CACHE_TTL_SECONDS = 3600;

/** 应在最终 CAS 写入时验证的 Cron 租约身份。 */
export type RefreshLease = { name: string; ownerToken: string };
type Mutation = Partial<EncryptedFields> & {
  name?: string;
  autoUpdateInterval?: number | null;
  lastUpdatedAt?: number;
  cacheExpiresAt?: number;
};

async function mutate(db: D1Database, row: SubscriptionRow, values: Mutation, now: number,
  state?: SubscriptionAutoUpdateStateFields, lease?: RefreshLease) {
  assertFits({ ...row, ...values });
  const revision = crypto.randomUUID();
  const update = db.prepare(`UPDATE Subscription SET ${Object.keys(values).map((key) => `${key} = ?, `).join("")}
    updatedAt = ?, revision = ? WHERE id = ? AND ownerId = ? AND revision = ?${lease ? `
      AND EXISTS (SELECT 1 FROM JobLeaseLock WHERE name = ? AND ownerToken = ? AND expiresAt > ?)` : ""}`)
    .bind(...Object.values(values), now, revision, row.id, row.ownerId, row.revision,
      ...(lease ? [lease.name, lease.ownerToken, now] : []));
  if (!state) return (await update.run()).meta.changes === 1 ? revision : null;
  checkRowSize([row.id, ...fields.map((key) => state[key])]);
  // D1 的 batch 不会因 UPDATE 命中零行而回滚，所以状态写入必须由同一批次的新版本门控。
  const saveState = db.prepare(`INSERT INTO SubscriptionAutoUpdateState (subscriptionId, ${fields.join(", ")}, createdAt, updatedAt)
    SELECT id, ${fields.map(() => "?").join(", ")}, ?, ? FROM Subscription WHERE id = ? AND revision = ?
    ON CONFLICT(subscriptionId) DO UPDATE SET ${fields.map((key) => `${key} = excluded.${key}`).join(", ")}, updatedAt = excluded.updatedAt`)
    .bind(...fields.map((key) => { const value = state[key]; return value instanceof Date ? value.getTime() : value; }),
      now, now, row.id, revision);
  const [updated] = await db.batch([update, saveState]);
  return updated.meta.changes === 1 ? revision : null;
}

/**
 * 用读取版本保护编辑，重新启用时原子清除失败状态。
 * @param db D1 绑定。
 * @param row 编辑前读取的版本。
 * @param input 校验后的字段、密钥、当前时间及可选重置状态。
 * @returns 编辑提交后的记录；并发修改或删除时为 null。
 * @throws SubscriptionStorageLimitError 加密后超出 D1 容量；D1 或加密失败也会传播。
 */
export async function saveSubscriptionEdit(db: D1Database, row: SubscriptionRow,
  input: SaveFields & { key: string; now: number; state?: SubscriptionAutoUpdateStateFields }) {
  const { secrets, key, now, name, autoUpdateInterval, state } = input;
  const values = { ...encryptSecrets(secrets, key), name, autoUpdateInterval };
  const revision = await mutate(db, row, values, now, state);
  return revision ? { ...row, ...values, revision, updatedAt: new Date(now), autoUpdateState: state ?? row.autoUpdateState } : null;
}

/**
 * 按所有权删除订阅及外键级联的刷新状态。
 * @param db D1 绑定。
 * @param ownerId 订阅所属管理员。
 * @param id 订阅 ID。
 * @returns 是否找到并删除。
 * @throws D1 写入失败。
 */
export async function removeSubscription(db: D1Database, ownerId: string, id: string) {
  const result = await db.prepare("DELETE FROM Subscription WHERE ownerId = ? AND id = ?").bind(ownerId, id).run();
  return result.meta.changes === 1;
}

/**
 * 原子比较旧令牌并轮换，同时推进刷新 CAS 版本。
 * @param db D1 主库绑定。
 * @param input 订阅 ID、所属管理员、If-Match 旧令牌和当前时间。
 * @returns 新令牌，或区分不存在与旧令牌冲突的结果。
 * @throws D1 读写失败。
 */
export async function rotateSubscriptionToken(db: D1Database,
  input: { ownerId: string; id: string; expectedToken: string; now: number }) {
  const { id, ownerId, expectedToken, now } = input;
  const token = randomBytes(32).toString("base64url");
  const rotated = await db.prepare(`UPDATE Subscription SET token = ?, updatedAt = ?, revision = ?
    WHERE id = ? AND ownerId = ? AND token = ? RETURNING id, token`)
    .bind(token, now, crypto.randomUUID(), id, ownerId, expectedToken).first<{ id: string; token: string }>();
  if (rotated) return { kind: "rotated", subscription: rotated } as const;
  const exists = await db.prepare("SELECT 1 FROM Subscription WHERE id = ? AND ownerId = ?").bind(id, ownerId).first();
  return { kind: exists ? "stale" : "not_found" } as const;
}

/**
 * 原子提交刷新缓存和/或状态；可用同一事务检验 Cron 租约归属及有效期。
 * @param db D1 绑定。
 * @param input row 是来源快照的读取版本；key 加密新缓存；now 为提交时毫秒；cache/state/interval 省略时保留原值。
 * @returns committed、stale（版本或租约不匹配）、storage_limit（不得发布快照或修改状态）。
 * @throws 非容量相关的 D1 或加密失败原样传播。
 */
export async function commitSubscriptionRefresh(db: D1Database, input: {
  row: SubscriptionRow;
  key: string;
  now: number;
  cache?: Extract<PreparedRefreshCacheSnapshot, { ok: true }>;
  state?: SubscriptionAutoUpdateStateFields;
  autoUpdateInterval?: number | null;
  lease?: RefreshLease;
}): Promise<"committed" | "stale" | "storage_limit"> {
  const { row, key, now, cache, state, autoUpdateInterval, lease } = input;
  try {
    const mutation: Mutation = {};
    if (autoUpdateInterval !== undefined) mutation.autoUpdateInterval = autoUpdateInterval;
    if (cache) {
      mutation.encryptedNodes = encrypt(cache.cacheEntry.nodes, key);
      mutation.encryptedConfig = encrypt(cache.refreshedConfig, key);
      mutation.encryptedSubscriptionInfo = encrypt(cache.cacheEntry.subscriptionInfo, key);
      mutation.lastUpdatedAt = now;
      mutation.cacheExpiresAt = now + SUBSCRIPTION_CACHE_TTL_SECONDS * 1000;
    }
    return await mutate(db, row, mutation, now, state, lease) ? "committed" : "stale";
  } catch (error) {
    if (error instanceof SubscriptionStorageLimitError) return "storage_limit";
    throw error;
  }
}
