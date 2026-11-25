-- 建立 Worker 的六张业务表与两张运行表。时间戳统一为 Unix 毫秒，由调用方传入；布尔值用 0/1。

CREATE TABLE LocalAdmin (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL UNIQUE,
  passwordHash TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  lastLoginAt INTEGER,
  allowUnsafeSubscriptionSources INTEGER NOT NULL DEFAULT 0 CHECK (allowUnsafeSubscriptionSources IN (0, 1))
);

-- 所有管理员竞争同一唯一键，避免依赖先查后写或固定 ID。
CREATE UNIQUE INDEX LocalAdmin_singleton ON LocalAdmin ((1));

CREATE TABLE LocalTemplate (
  id TEXT PRIMARY KEY NOT NULL,
  ownerId TEXT NOT NULL REFERENCES LocalAdmin (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  encryptedConfig TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX LocalTemplate_ownerId_idx ON LocalTemplate (ownerId);
CREATE INDEX LocalTemplate_updatedAt_idx ON LocalTemplate (updatedAt);

CREATE TABLE Subscription (
  id TEXT PRIMARY KEY NOT NULL,
  ownerId TEXT NOT NULL REFERENCES LocalAdmin (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  -- 写入时分配一次性版本值，避免毫秒碰撞或并发 CAS 的相同预期新值。
  revision TEXT NOT NULL,
  isPrimary INTEGER NOT NULL DEFAULT 0 CHECK (isPrimary IN (0, 1)),
  encryptedUrls TEXT NOT NULL,
  encryptedNodes TEXT NOT NULL,
  encryptedConfig TEXT NOT NULL,
  encryptedSubscriptionInfo TEXT,
  autoUpdateInterval INTEGER,
  cacheExpiresAt INTEGER,
  lastAccessedAt INTEGER,
  lastUpdatedAt INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX Subscription_ownerId_idx ON Subscription (ownerId);
CREATE INDEX Subscription_lastUpdatedAt_idx ON Subscription (lastUpdatedAt);

CREATE TABLE SubscriptionAutoUpdateState (
  subscriptionId TEXT PRIMARY KEY NOT NULL REFERENCES Subscription (id) ON DELETE CASCADE,
  externalFailureCount INTEGER NOT NULL DEFAULT 0,
  failureSourceState TEXT,
  lastFailedAt INTEGER,
  lastAttemptedAt INTEGER,
  nodeQuotaFailureCount INTEGER NOT NULL DEFAULT 0,
  lastNodeQuotaExceededAt INTEGER,
  lastNodeQuotaActual INTEGER,
  lastNodeQuotaLimit INTEGER,
  disabledAt INTEGER,
  disabledReason TEXT,
  disabledPreviousInterval INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE JobLeaseLock (
  name TEXT PRIMARY KEY NOT NULL,
  ownerToken TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX JobLeaseLock_expiresAt_idx ON JobLeaseLock (expiresAt);

CREATE TABLE RevokedSession (
  revocationKey TEXT PRIMARY KEY NOT NULL,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX RevokedSession_expiresAt_idx ON RevokedSession (expiresAt);

-- geosite 和 geoip 存储 JSON 数组，保持同一份索引快照原子更新。
CREATE TABLE RuleIndexCache (
  key TEXT PRIMARY KEY NOT NULL,
  geosite TEXT NOT NULL,
  geoip TEXT NOT NULL,
  fetchedAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE AuthRateLimit (
  scope TEXT NOT NULL,
  ipHash TEXT NOT NULL,
  count INTEGER NOT NULL,
  resetAt INTEGER NOT NULL,
  PRIMARY KEY (scope, ipHash)
);
CREATE INDEX AuthRateLimit_resetAt_idx ON AuthRateLimit (resetAt);
