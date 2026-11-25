// 验证 Worker 的初始 SQL 迁移所保证的 D1 写入约束。
import { expect, it } from "vitest";
import { createWorkerFixture } from "./fixture";

/** 即使同时写入不同 ID 和用户名，数据库也只接受一位管理员。 */
it("并发写入两个不同管理员时，D1 只保留一条记录", async () => {
  await using fixture = await createWorkerFixture();
  const { db } = fixture;
  const insert = db.prepare(`
    INSERT INTO LocalAdmin (id, username, passwordHash, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  const results = await Promise.allSettled([
    insert.bind("first", "alice", "test-hash", now, now).run(),
    insert.bind("second", "bob", "test-hash", now, now).run(),
  ]);

  expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
  const rejected = results.find((result) => result.status === "rejected");
  expect(rejected?.reason).toHaveProperty("message", expect.stringContaining("UNIQUE constraint failed"));
  expect(await db.prepare("SELECT COUNT(*) AS count FROM LocalAdmin").first("count")).toBe(1);
});
