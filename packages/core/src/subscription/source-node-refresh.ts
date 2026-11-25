// 合并订阅源的最新节点并保留管理员的命名和来源归属。
import { formatNodeNameFromTemplate } from "../node-name-template";
import { buildNodeContentKey, buildScopedNodeIdentityKey, type NodeContentKeyOptions } from "../node-identity";
import { stripImportedNodeControlFields } from "./imported-node-controls";
import {
  getNodeOriginName,
  getNodeSourceIds,
  makeUniqueName,
  normalizeNodeOriginName,
  ORIGIN_NAME_KEY,
  SOURCE_IDS_KEY,
  withoutNodeSourceIds,
} from "./node-source-state";
import type { ParsedNode } from "../types/node";

export type SourceRefreshDescriptor = {
  sourceId: string;
  currentTag?: string;
  currentNameTemplate?: string;
  lastTag?: string;
  lastNameTemplate?: string;
  treatAsNewSource?: boolean;
  smartNodeMatchingEnabled?: boolean;
  deletedNodes?: DeletedNodeDescriptor[];
};

export type MergeSourceNodesResult = {
  nodes: ParsedNode[];
  renameMap: Map<string, string>;
};

export type DeletedNodeDescriptor = {
  originName?: unknown;
  name?: unknown;
  node?: ParsedNode;
};

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function prepareSourceParsedNodes(
  nodes: ParsedNode[],
  descriptor: Pick<SourceRefreshDescriptor, "currentTag" | "currentNameTemplate">
): ParsedNode[] {
  const tag = normalizeOptionalString(descriptor.currentTag);
  const template = normalizeOptionalString(descriptor.currentNameTemplate);

  return nodes.map((node) => {
    const sanitizedNode = stripImportedNodeControlFields(node);
    const record = sanitizedNode as unknown as Record<string, unknown>;
    const originName = getNodeOriginName(sanitizedNode).trim();

    const displayName = formatNodeNameFromTemplate({
      originName,
      tag,
      template,
    });

    return ({
      ...record,
      name: displayName || originName,
      [ORIGIN_NAME_KEY]: originName,
    } as unknown as ParsedNode);
  });
}

export function detachSourceNodesFromState(
  stateNodes: ParsedNode[],
  sourceId: string
): MergeSourceNodesResult {
  const removed = new Set([sourceId]);
  const nextNodes: ParsedNode[] = [];

  for (const rawNode of stateNodes) {
    const node = normalizeNodeOriginName(rawNode);
    const next = withoutNodeSourceIds(node, removed);
    if (next) nextNodes.push(next);
  }

  return { nodes: nextNodes, renameMap: new Map<string, string>() };
}

// 依照连接信息的精确程度逐级放宽，同一级有歧义时交给下一层或原有名称回退。
const ORIGIN_FINGERPRINT_SCOPES: readonly (NodeContentKeyOptions | undefined)[] = [
  undefined,
  { ignoreServer: true },
  { ignoreServer: true, ignorePort: true },
  { ignoreServer: true, ignorePort: true, ignoreSni: true, ignoreServername: true },
];

/**
 * 合并来源刷新结果，按原名和后备匹配规则保留用户命名、删除记录与多来源归属。
 * @param stateNodes 当前已保存的节点顺序和归属。
 * @param parsedNodes 已应用当前来源命名模板的新节点。
 * @param deletedNodeNames 旧格式中保存的删除标记。
 * @param descriptor 来源标识、命名模板和匹配策略。
 * @returns 合并后的节点和需要更新配置引用的改名映射。
 */
export function mergeParsedSourceNodes(
  stateNodes: ParsedNode[],
  parsedNodes: ParsedNode[],
  deletedNodeNames: string[],
  descriptor: SourceRefreshDescriptor
): MergeSourceNodesResult {
  const sourceId = descriptor.sourceId;
  const lastTag = normalizeOptionalString(descriptor.lastTag);
  const lastNameTemplate = normalizeOptionalString(descriptor.lastNameTemplate);
  const treatAsNewSource = descriptor.treatAsNewSource === true;
  const smartNodeMatchingEnabled = descriptor.smartNodeMatchingEnabled !== false;

  const originOf = (node: ParsedNode) => getNodeOriginName(node).trim() || node.name;
  const keyOf = (node: ParsedNode) => buildScopedNodeIdentityKey(originOf(node), node);

  const mergeUnique = (map: Map<string, string | null>, key: string, value: string) => {
    const existed = map.get(key);
    if (existed === undefined) {
      map.set(key, value);
      return;
    }
    if (existed === value || existed === null) return;
    map.set(key, null);
  };

  const deleted = new Set(
    deletedNodeNames
      .filter((name) => typeof name === "string")
      .map((name) => name.trim())
      .filter(Boolean)
  );
  const deletedNodeKeys = new Set<string>();
  for (const item of Array.isArray(descriptor.deletedNodes) ? descriptor.deletedNodes : []) {
    if (!item?.node) continue;
    const node = normalizeNodeOriginName(item.node);
    const origin = normalizeOptionalString(item.originName) ?? (getNodeOriginName(node).trim() || node.name);
    if (!origin) continue;
    deletedNodeKeys.add(buildScopedNodeIdentityKey(origin, node));
  }

  const freshOriginCounts = new Map<string, number>();
  // 只需要为旧格式的名称删除标记区分重名节点；精确删除不使用这个计数。
  if (deleted.size > 0) {
    for (const rawNode of parsedNodes) {
      const node = normalizeNodeOriginName(rawNode);
      const origin = originOf(node);
      if (!origin) continue;
      freshOriginCounts.set(origin, (freshOriginCounts.get(origin) ?? 0) + 1);
    }
  }

  const isDeleted = (node: ParsedNode, originNameRaw: string, displayNameRaw?: string): boolean => {
    const originName = (originNameRaw || "").trim();
    if (!originName) return false;
    if (deletedNodeKeys.size > 0 && deletedNodeKeys.has(buildScopedNodeIdentityKey(originName, node))) return true;
    if (deleted.size === 0) return false;

    // Legacy deletedNodeNames are only origin/display-name markers. When a source
    // emits many distinct nodes with the same default origin name, a single
    // coarse marker must not hide the entire batch.
    if ((freshOriginCounts.get(originName) ?? 0) > 1) return false;

    if (deleted.has(originName)) return true;

    const displayName = typeof displayNameRaw === "string" ? displayNameRaw.trim() : "";
    if (displayName && deleted.has(displayName)) return true;

    const previousAutoName = formatNodeNameFromTemplate({
      originName,
      tag: lastTag,
      template: lastNameTemplate,
    });
    return Boolean(previousAutoName && deleted.has(previousAutoName));
  };

  const freshOrdered: ParsedNode[] = [];
  const freshSeenKeys = new Set<string>();
  const freshOriginNames = new Set<string>();
  const freshByOrigin = new Map<string, ParsedNode[]>();
  const originByFingerprint = new Map<NodeContentKeyOptions | undefined, Map<string, string | null>>();

  for (const rawNode of parsedNodes) {
    const node = normalizeNodeOriginName(rawNode);
    const origin = originOf(node);
    if (!origin) continue;
    if (isDeleted(node, origin, node.name)) continue;

    const key = keyOf(node);
    if (freshSeenKeys.has(key)) continue;
    freshSeenKeys.add(key);

    freshOrdered.push(node);
    freshOriginNames.add(origin);
    const list = freshByOrigin.get(origin) ?? [];
    list.push(node);
    freshByOrigin.set(origin, list);
  }

  const inferMatchingOriginName = (node: ParsedNode): string | null => {
    if (!smartNodeMatchingEnabled) return null;

    // 原名仍在时无需模糊匹配。只有走到某一级后备规则时，才为整批新节点构建该级指纹。
    for (const scope of ORIGIN_FINGERPRINT_SCOPES) {
      let origins = originByFingerprint.get(scope);
      if (!origins) {
        origins = new Map();
        for (const fresh of freshOrdered) {
          mergeUnique(origins, buildNodeContentKey(fresh, scope), originOf(fresh));
        }
        originByFingerprint.set(scope, origins);
      }
      const inferred = origins.get(buildNodeContentKey(node, scope))?.trim();
      if (inferred) return freshOriginNames.has(inferred) ? inferred : null;
    }
    return null;
  };

  const isUserRenamed = (nodeName: string, originName: string) => {
    if (treatAsNewSource) return false;
    const previousAutoName = formatNodeNameFromTemplate({
      originName,
      tag: lastTag,
      template: lastNameTemplate,
    });
    return nodeName !== previousAutoName;
  };

  const hasExplicitOriginName = (node: ParsedNode): boolean => {
    const record = node as unknown as Record<string, unknown>;
    return typeof record[ORIGIN_NAME_KEY] === "string" && String(record[ORIGIN_NAME_KEY]).trim().length > 0;
  };

  const resolveOriginName = (
    node: ParsedNode,
    options: { allowDisplayNameFallback: boolean }
  ): string | null => {
    const record = node as unknown as Record<string, unknown>;
    const originRaw =
      typeof record[ORIGIN_NAME_KEY] === "string" && String(record[ORIGIN_NAME_KEY]).trim()
        ? String(record[ORIGIN_NAME_KEY]).trim()
        : "";

    if (originRaw && freshOriginNames.has(originRaw)) return originRaw;
    const inferred = inferMatchingOriginName(node);
    if (inferred) return inferred;

    const candidate = (node.name || "").trim();
    if (options.allowDisplayNameFallback && candidate && freshOriginNames.has(candidate)) {
      const sameTypeExists = freshOrdered.some((item) => originOf(item) === candidate && item.type === node.type);
      if (sameTypeExists) return candidate;
    }

    return originRaw ? originRaw : null;
  };

  const buildNextSourceIds = (existingSourceIds: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (raw: string) => {
      const sid = (raw || "").trim();
      if (!sid || seen.has(sid)) return;
      seen.add(sid);
      out.push(sid);
    };
    for (const id of existingSourceIds) push(id);
    push(sourceId);
    return out;
  };

  const mergeNodeWithFresh = (params: {
    stored: ParsedNode;
    fresh: ParsedNode;
    originName: string;
    desiredName: string;
    extraSourceIds: string[];
  }): ParsedNode => {
    const storedRecord = params.stored as unknown as Record<string, unknown>;
    const freshRecord = params.fresh as unknown as Record<string, unknown>;
    const preservedExtra = Object.fromEntries(
      Object.entries(storedRecord).filter(
        ([key]) => key.startsWith("_") && key !== ORIGIN_NAME_KEY && key !== SOURCE_IDS_KEY
      )
    );

    return ({
      ...freshRecord,
      ...preservedExtra,
      name: params.desiredName,
      [ORIGIN_NAME_KEY]: params.originName,
      [SOURCE_IDS_KEY]: buildNextSourceIds(params.extraSourceIds),
    } as unknown as ParsedNode);
  };

  // 两个新节点索引都保留同一个已去重对象，消费标记不必重算内容指纹。
  const consumedFresh = new Set<ParsedNode>();
  const originConsumed = new Map<string, number>();
  const takeFresh = (originName: string): ParsedNode | null => {
    const list = freshByOrigin.get(originName);
    if (!list || list.length === 0) return null;
    const idx = originConsumed.get(originName) ?? 0;
    if (idx >= list.length) return null;
    originConsumed.set(originName, idx + 1);
    const fresh = list[idx];
    consumedFresh.add(fresh);
    return fresh;
  };

  const removed = new Set([sourceId]);
  const baseNodes: ParsedNode[] = [];
  const baseOldNames: Array<string | null> = [];
  const baseFixed: boolean[] = [];
  let hadExistingSourceNodes = false;

  const pushPlanned = (node: ParsedNode, oldName: string | null, fixedName: boolean) => {
    baseNodes.push(node);
    baseOldNames.push(oldName);
    baseFixed.push(fixedName);
  };

  for (const rawNode of stateNodes) {
    const explicitOriginName = hasExplicitOriginName(rawNode);
    const node = normalizeNodeOriginName(rawNode);
    const sourceIds = getNodeSourceIds(node);
    const allowDisplayNameFallback = smartNodeMatchingEnabled || !explicitOriginName;

    if (sourceIds.includes(sourceId)) {
      hadExistingSourceNodes = true;
      const previousOriginName = originOf(node);
      const originName = resolveOriginName(node, { allowDisplayNameFallback }) ?? previousOriginName;
      const fresh = originName ? takeFresh(originName) : null;

      const base = withoutNodeSourceIds(node, removed);
      if (!fresh) {
        if (base) pushPlanned(base, base.name, true);
        continue;
      }

      const keepUserName = previousOriginName ? isUserRenamed(node.name, previousOriginName) : false;
      const desiredName = keepUserName ? node.name : fresh.name;
      const extraIds = base ? getNodeSourceIds(base) : sourceIds.filter((id) => id !== sourceId);

      const merged = mergeNodeWithFresh({
        stored: node,
        fresh,
        originName: originName || originOf(fresh),
        desiredName,
        extraSourceIds: extraIds,
      });
      pushPlanned(merged, node.name, keepUserName);
      continue;
    }

    if (sourceIds.length === 0 && freshOriginNames.size > 0) {
      const originName = resolveOriginName(node, { allowDisplayNameFallback });
      if (originName && freshOriginNames.has(originName)) {
        hadExistingSourceNodes = true;
        const fresh = takeFresh(originName);
        if (!fresh) {
          continue;
        }

        const keepUserName = isUserRenamed(node.name, originName);
        const desiredName = keepUserName ? node.name : fresh.name;
        const merged = mergeNodeWithFresh({
          stored: node,
          fresh,
          originName,
          desiredName,
          extraSourceIds: [],
        });
        pushPlanned(merged, node.name, keepUserName);
        continue;
      }
    }

    pushPlanned(node, node.name, true);
  }

  let baseKeyToIndex: Map<string, number> | undefined;
  const newNodes: ParsedNode[] = [];
  for (const node of freshOrdered) {
    if (consumedFresh.has(node)) continue;

    let existingIndex: number | undefined;
    if (smartNodeMatchingEnabled) {
      // 全部新节点都按原名匹配时，没有跨来源节点需要再做内容匹配。
      if (!baseKeyToIndex) {
        baseKeyToIndex = new Map(baseNodes.map((base, index) => [keyOf(base), index]));
      }
      existingIndex = baseKeyToIndex.get(keyOf(node));
    }
    if (existingIndex !== undefined) {
      const existing = baseNodes[existingIndex];
      baseNodes[existingIndex] = mergeNodeWithFresh({
        stored: existing,
        fresh: node,
        originName: originOf(node),
        desiredName: existing.name,
        extraSourceIds: getNodeSourceIds(existing),
      });
      continue;
    }

    const record = node as unknown as Record<string, unknown>;
    const originName = originOf(node);
    newNodes.push(
      ({
        ...record,
        [ORIGIN_NAME_KEY]: originName,
        [SOURCE_IDS_KEY]: [sourceId],
      } as unknown as ParsedNode)
    );
  }

  const insertionIndex = (() => {
    if (!hadExistingSourceNodes) return baseNodes.length;
    for (let i = baseNodes.length - 1; i >= 0; i -= 1) {
      if (getNodeSourceIds(baseNodes[i]).includes(sourceId)) return i + 1;
    }
    return baseNodes.length;
  })();

  const combinedNodes =
    newNodes.length > 0
      ? [...baseNodes.slice(0, insertionIndex), ...newNodes, ...baseNodes.slice(insertionIndex)]
      : baseNodes;
  const combinedOldNames =
    newNodes.length > 0
      ? [...baseOldNames.slice(0, insertionIndex), ...new Array(newNodes.length).fill(null), ...baseOldNames.slice(insertionIndex)]
      : baseOldNames;
  const combinedFixed =
    newNodes.length > 0
      ? [...baseFixed.slice(0, insertionIndex), ...new Array(newNodes.length).fill(false), ...baseFixed.slice(insertionIndex)]
      : baseFixed;

  const renameMap = new Map<string, string>();
  const usedNames = new Set<string>();
  const nextNodes = combinedNodes.map((node) => node);

  const setNodeName = (idx: number, nextName: string) => {
    const node = nextNodes[idx];
    if (node.name === nextName) return;
    const record = node as unknown as Record<string, unknown>;
    nextNodes[idx] = ({ ...record, name: nextName } as unknown as ParsedNode);
  };

  for (let i = 0; i < nextNodes.length; i += 1) {
    if (!combinedFixed[i]) continue;
    const desired = nextNodes[i].name;
    const finalName = makeUniqueName(desired, usedNames);
    usedNames.add(finalName);
    setNodeName(i, finalName);
    const oldName = combinedOldNames[i];
    if (oldName && finalName !== oldName) renameMap.set(oldName, finalName);
  }

  for (let i = 0; i < nextNodes.length; i += 1) {
    if (combinedFixed[i]) continue;
    const desired = nextNodes[i].name;
    const finalName = makeUniqueName(desired, usedNames);
    usedNames.add(finalName);
    setNodeName(i, finalName);
    const oldName = combinedOldNames[i];
    if (oldName && finalName !== oldName) renameMap.set(oldName, finalName);
  }

  return { nodes: nextNodes, renameMap };
}
