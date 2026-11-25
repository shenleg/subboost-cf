// 组装模板列表、详情、上传和删除端点。
import { buildDefaultSubBoostTemplateConfig } from "@subboost/core/config/defaults";
import { getTemplateList } from "@subboost/core/templates";
import { builtinIdToType, getBuiltinTemplateId, getBuiltinTemplateSummaryMetadata } from "@subboost/core/templates/builtin";
import { validateSubBoostTemplateConfig } from "@subboost/core/templates/config-template";
import type { SubBoostTemplateConfig } from "@subboost/core/types/template-config";
import { decryptEncryptedFieldV2, encryptEncryptedFieldV2 } from "@subboost/server-core/crypto";
import { readJsonBody } from "@subboost/server-core/http";
import { parseCurrentTemplateTab } from "@subboost/server-core/templates";
import { Hono } from "hono";
import { getEncryptionKey, nowMs, type WorkerApp } from "../env";
import { withCurrentAdmin } from "./auth";

// 保留原版请求上限；经校验的配置另受 D1 整行上限约束。
const TEMPLATE_BODY_LIMIT = 4 * 1024 * 1024;
const D1_ROW_BYTES = 2_000_000;
// 时间戳与 SQLite 记录头不在下方的字符串字节计量内，预留固定空间。
const D1_ROW_OVERHEAD_BYTES = 256;
const NAME_LIMIT = 100;
const DESCRIPTION_LIMIT = 500;
const NOT_FOUND = { error: "Template not found.", code: "NOT_FOUND" } as const;

type TemplateRow = {
  id: string;
  name: string;
  description: string | null;
  createdAt: number;
  encryptedConfig: string;
};
type TemplateMetadata = Omit<TemplateRow, "encryptedConfig">;

function privateSummary(row: TemplateMetadata, config: SubBoostTemplateConfig) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    downloads: 0,
    engagementCount: 0,
    createdAt: new Date(row.createdAt).toISOString(),
    tags: ["本地"],
    isOfficial: false,
    isPublic: false,
    isOwner: true,
    proxyGroupCount: Array.isArray(config.enabledProxyGroups) ? config.enabledProxyGroups.length : null,
    ruleCount: Array.isArray(config.ruleOrder) ? config.ruleOrder.length : null,
  };
}

function decryptConfig(row: TemplateRow, key: string): SubBoostTemplateConfig {
  return JSON.parse(decryptEncryptedFieldV2(row.encryptedConfig, key));
}

function builtinSummaries() {
  return getTemplateList().map((template) => ({
    ...getBuiltinTemplateSummaryMetadata(),
    id: getBuiltinTemplateId(template.id),
    name: template.name,
    description: template.description,
    proxyGroupCount: template.groupCount,
    ruleCount: template.ruleCount,
  }));
}

function templateList<T>(templates: T[]) {
  return {
    templates,
    pagination: { page: 1, limit: templates.length, total: templates.length, totalPages: 1 },
  };
}

/** 挂在 `/api` 下，提供公开内置模板及私有模板管理。 */
export const templateRoutes = new Hono<WorkerApp>()
  .get("/templates", (c) => {
    const tab = parseCurrentTemplateTab(c.req.query("type") ?? null, {
      supportedTabs: ["default", "my"],
      defaultTab: "default",
    });
    if (!tab.ok) return c.json({ error: "Invalid template type.", code: "VALIDATION_ERROR" }, 400);
    const ids = new Set(c.req.query("ids")?.split(",").map((id) => id.trim()).filter(Boolean));
    const matchesId = (template: { id: string }) => !ids.size || ids.has(template.id);
    if (tab.tab === "default") return c.json(templateList(builtinSummaries().filter(matchesId)));

    return withCurrentAdmin(c, async ({ id: ownerId }) => {
      try {
        // D1 限制绑定参数数量；先按所有者查询，再应用可选的 ids 筛选。
        const { results } = await c.env.DB.prepare(`
          SELECT id, name, description, createdAt, encryptedConfig FROM LocalTemplate
          WHERE ownerId = ? ORDER BY updatedAt DESC
        `).bind(ownerId).all<TemplateRow>();
        const key = getEncryptionKey(c.env)!;
        return c.json(templateList(results.filter(matchesId).map((row) => privateSummary(row, decryptConfig(row, key)))));
      } catch {
        return c.json({ error: "Unable to list templates.", code: "BAD_REQUEST" }, 400);
      }
    });
  })
  .get("/templates/:id", (c) => {
    const id = c.req.param("id");
    const builtinType = builtinIdToType(id);
    if (builtinType) {
      const summary = builtinSummaries().find((item) => item.id === id);
      return c.json({ template: {
        id,
        name: summary?.name || builtinType,
        description: summary?.description || "",
        kind: "config",
        config: buildDefaultSubBoostTemplateConfig(builtinType),
      } });
    }

    return withCurrentAdmin(c, async ({ id: ownerId }) => {
      try {
        const row = await c.env.DB.prepare(`
          SELECT id, name, description, createdAt, encryptedConfig FROM LocalTemplate
          WHERE id = ? AND ownerId = ?
        `).bind(id, ownerId).first<TemplateRow>();
        if (!row) return c.json(NOT_FOUND, 404);
        return c.json({ template: {
          id: row.id, name: row.name, description: row.description || "", kind: "config",
          config: decryptConfig(row, getEncryptionKey(c.env)!),
        } });
      } catch {
        return c.json({ error: "Unable to load template.", code: "BAD_REQUEST" }, 400);
      }
    });
  })
  .post("/templates", (c) => withCurrentAdmin(c, async ({ id: ownerId }) => {
    const parsed = await readJsonBody(c.req.raw, TEMPLATE_BODY_LIMIT);
    if (!parsed.ok && parsed.reason === "too_large") {
      return c.json({ error: "Request body is too large.", code: "PAYLOAD_TOO_LARGE" }, 413);
    }
    if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
      return c.json({ error: "Invalid JSON body.", code: "BAD_REQUEST" }, 400);
    }
    const body = parsed.value as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > NAME_LIMIT) return c.json({ error: "Invalid name.", code: "BAD_REQUEST" }, 400);
    const validated = validateSubBoostTemplateConfig(body.config);
    if (!validated.ok) return c.json({ error: validated.error, code: "BAD_REQUEST" }, 400);
    const description = typeof body.description === "string" ? body.description.trim().slice(0, DESCRIPTION_LIMIT) : "";
    const row = { id: crypto.randomUUID(), name, description, createdAt: nowMs(c.env) };
    try {
      const encrypted = encryptEncryptedFieldV2(JSON.stringify(validated.config), getEncryptionKey(c.env)!);
      // v2 密文是 ASCII；其余字段需要按 UTF-8 计量，不能用 JS 字符数估计。
      const rowBytes = encrypted.length + Buffer.byteLength(row.id + ownerId + name + description) + D1_ROW_OVERHEAD_BYTES;
      if (rowBytes > D1_ROW_BYTES) return c.json({
        error: "模板加密后超过 Cloudflare D1 单行存储上限（2 MB），请缩小模板配置。",
        code: "PAYLOAD_TOO_LARGE",
      }, 413);
      await c.env.DB.prepare(`
        INSERT INTO LocalTemplate (id, ownerId, name, description, encryptedConfig, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(row.id, ownerId, name, description, encrypted, row.createdAt, row.createdAt).run();
      return c.json({ template: privateSummary(row, validated.config) }, 201);
    } catch {
      return c.json({ error: "Unable to create template.", code: "BAD_REQUEST" }, 400);
    }
  }))
  .delete("/templates", (c) => withCurrentAdmin(c, async ({ id: ownerId }) => {
    const id = c.req.query("id")?.trim();
    if (!id) return c.json({ error: "Template ID required.", code: "BAD_REQUEST" }, 400);
    // 将所有者约束放在同一条删除语句中，不在鉴权检查与写入之间留窗口。
    const { meta } = await c.env.DB.prepare("DELETE FROM LocalTemplate WHERE id = ? AND ownerId = ?")
      .bind(id, ownerId).run();
    return meta.changes ? c.json({ success: true }) : c.json(NOT_FOUND, 404);
  }));
