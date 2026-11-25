// 仅运行 Wrangler 干跑，并以整份 Worker 上传报告执行项目体积门禁。
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const require = createRequire(import.meta.url);
const wranglerManifest = require.resolve("wrangler/package.json");
const wrangler = resolve(dirname(wranglerManifest), require(wranglerManifest).bin.wrangler);
const result = spawnSync(process.execPath, [wrangler, "deploy", "--dry-run"], {
  encoding: "utf8",
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});

process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error || result.status !== 0) {
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status || 1;
} else {
  const upload = stripVTControlCharacters(result.stdout).match(
    /^Total Upload: \d+\.\d{2} KiB \/ gzip: (\d+\.\d{2}) KiB\r?$/m,
  );
  // Wrangler 只报告保留两位小数的 KiB；按舍入上界比较，避免误放行临界值。
  const gzipUpperBytes = upload ? (Number(upload[1]) + 0.005) * 1024 : Infinity;
  const maxGzipBytes = 3_000_000; // 项目门禁使用十进制 MB，并严格小于阈值。
  if (!(gzipUpperBytes < maxGzipBytes)) {
    console.error(upload ? "Worker gzip 体积必须严格小于 3 MB（3,000,000 字节）。" : "无法解析 Wrangler 的 Total Upload gzip 体积。");
    process.exitCode = 1;
  }
}
