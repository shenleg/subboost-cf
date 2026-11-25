-- 隔离手动刷新和 Cron 的凭据、进度及终态，避免二者用同一尝试的失败结果。
CREATE TABLE SubscriptionManualRefreshProgress (
  subscriptionId TEXT NOT NULL REFERENCES Subscription (id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  part INTEGER NOT NULL,
  payload TEXT,
  expiresAt INTEGER NOT NULL,
  PRIMARY KEY (subscriptionId, revision, part),
  CHECK ((part = -1 AND payload IS NULL) OR (part >= 0 AND payload IS NOT NULL))
);
CREATE INDEX SubscriptionManualRefreshProgress_expiresAt_idx ON SubscriptionManualRefreshProgress (expiresAt);
