// 组装上游发布检查端点，版本来自构建输入而不是运行期文件系统。
import { Hono } from "hono";
import { version as WORKER_VERSION } from "../../../package.json";
import type { WorkerApp } from "../env";
import { getExternalFetch } from "../transport";

/** Worker 发布版本；Wrangler 将根包元数据中的版本静态打入使用它的产物。 */
export { WORKER_VERSION };

const DEFAULT_REPO = "SubBoost/subboost";
// 保持原版一小时的回源与客户端缓存时长。
const CACHE_SECONDS = 3600;
const CACHE_HEADERS = {
  "Cache-Control": `public, max-age=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS}`,
};
const FALLBACK = {
  currentVersion: WORKER_VERSION,
  latestVersion: null,
  latestTag: null,
  releaseUrl: null,
  hasUpdate: false,
};

function releaseRepo(value: string | undefined): string {
  if (!value || value !== value.trim()) return DEFAULT_REPO;
  // GitHub owner 允许用单个连字符分隔字母数字；仓库名另允许点、横线和下划线。
  const match = /^(?=[^/]{1,39}\/)[a-z0-9]+(?:-[a-z0-9]+)*\/([a-z0-9_.-]{1,100})$/i.exec(value);
  return match && match[1] !== "." && match[1] !== ".." ? value : DEFAULT_REPO;
}

function stableVersion(tag: string) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? { parts, normalized: match.slice(1).join(".") } : null;
}

function isNewer(latest: number[], current: number[]): boolean {
  const firstDifference = latest.findIndex((part, index) => part !== current[index]);
  return firstDifference !== -1 && latest[firstDifference] > current[firstDifference];
}

function releaseUrl(repo: string, tag: string, value: unknown): string {
  const canonical = `https://github.com/${repo}/releases/tag/${tag}`;
  // GitHub 可能返回大小写不同的仓库名；只接受指向同一发布页的链接。
  const supplied = typeof value === "string" ? value.trim() : "";
  return supplied.toLowerCase() === canonical.toLowerCase() && supplied.endsWith(`/releases/tag/${tag}`)
    ? supplied
    : canonical;
}

/** 挂在 `/api` 下，公开返回当前版本及上游最新稳定版。 */
export const releaseRoutes = new Hono<WorkerApp>().get("/releases/latest", async (c) => {
  const fallback = () => c.json(FALLBACK, 200, CACHE_HEADERS);
  const current = stableVersion(WORKER_VERSION);
  if (!current) return fallback();
  const repo = releaseRepo(c.env.RELEASE_REPO);
  try {
    const response = await getExternalFetch(c.env)(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "SubBoost Worker release check" },
      cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": CACHE_SECONDS, "300-599": -1 } },
      redirect: "manual",
    });
    if (!response.ok) return fallback();
    const release = await response.json<{ tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown }>();
    if (!release || [release.draft, release.prerelease].some((flag) => flag !== undefined && flag !== false)) return fallback();
    const latestTag = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
    const latest = stableVersion(latestTag);
    if (!latest) return fallback();
    return c.json({
      currentVersion: WORKER_VERSION,
      latestVersion: latest.normalized,
      latestTag,
      releaseUrl: releaseUrl(repo, latestTag, release.html_url),
      hasUpdate: isNewer(latest.parts, current.parts),
    }, 200, CACHE_HEADERS);
  } catch {
    return fallback();
  }
});
