-- 持久化订阅 Cron 的公平扫描位置，避免每次都让旧失败项排在未处理项前面。
CREATE TABLE SubscriptionCronSweep (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  startedAt INTEGER,
  afterTime INTEGER,
  afterId TEXT
);

CREATE INDEX Subscription_cronOrder_idx ON Subscription (COALESCE(lastUpdatedAt, createdAt), id)
  WHERE autoUpdateInterval IS NOT NULL;

-- 阶段密文按 D1 单行上限分片；part = -1 是同版本的本地容量冷却，不属于订阅失败状态。
CREATE TABLE SubscriptionCronProgress (
  subscriptionId TEXT NOT NULL REFERENCES Subscription (id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  part INTEGER NOT NULL,
  payload TEXT,
  expiresAt INTEGER NOT NULL,
  PRIMARY KEY (subscriptionId, revision, part),
  CHECK ((part = -1 AND payload IS NULL) OR (part >= 0 AND payload IS NOT NULL))
);
CREATE INDEX SubscriptionCronProgress_expiresAt_idx ON SubscriptionCronProgress (expiresAt);
