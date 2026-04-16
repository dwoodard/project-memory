import type kuzu from "kuzu";
import { queryBuilder } from "./kuzu-helpers.js";

export type WalkDirection = "outbound" | "inbound" | "both";
export type WalkStrategy = "bfs" | "dfs";

export interface NodeRef {
  id: string;
  type?: string;
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface WalkFilter {
  includeTypes?: string[];
  excludeTypes?: string[];
  propertyPredicates?: Array<{ key: string; value: string }>;
}

export interface WalkOptions {
  relations?: string[] | "any";
  direction?: WalkDirection;
  depth?: number;
  maxNodes?: number;
  maxVisited?: number;
  strategy?: WalkStrategy;
  filter?: WalkFilter;
  pageSize?: number;
  stream?: boolean;
}

export interface WalkResult {
  node: GraphNode;
  relations: Array<{
    type: string;
    targets: Array<{ node: GraphNode; properties: Record<string, unknown> }>;
  }>;
  depth: number;
  isSeed: boolean;
}

export interface WalkMetadata {
  visitedCount: number;
  emittedCount: number;
  durationMs: number;
  truncated: boolean;
  truncationReason?: "maxNodes" | "maxVisited";
  pageSize: number;
}

export interface WalkTraversalResult {
  nodes: WalkResult[];
  metadata: WalkMetadata;
}

export interface ResolvedStartNode {
  node: GraphNode;
  ref: NodeRef;
}

export interface WalkCliInput {
  id?: string;
  startId?: string;
  startType?: string;
  sessionId?: string;
  taskId?: string;
}

const DEFAULT_RELATIONS = [
  "HAS_SESSION",
  "HAS_TASK",
  "HAS_MEMORY",
  "HAS_TURN",
  "REFERENCES",
  "RELATED_TO",
  "LINKED",
  "WORKED_ON",
  "MENTIONS",
] as const;

const KNOWN_NODE_TYPES = ["Project", "Session", "Task", "Memory", "Turn", "File"] as const;
const TYPES_WITH_TITLE = new Set(["Session", "Task", "Memory"]);

const TYPE_ALIASES: Record<string, string> = {
  project: "Project",
  session: "Session",
  task: "Task",
  memory: "Memory",
  event: "Turn",
  turn: "Turn",
  file: "File",
};

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isSafeIdentifier(value: string): boolean {
  return IDENTIFIER_RE.test(value);
}

function normalizeTypeLabel(type?: string): string | undefined {
  if (!type) return undefined;
  const t = type.trim();
  if (!t) return undefined;
  const alias = TYPE_ALIASES[t.toLowerCase()];
  if (alias) return alias;
  return `${t[0].toUpperCase()}${t.slice(1)}`;
}

function nodeFromRecord(node: Record<string, unknown>, typeHint?: string): GraphNode {
  const id = String(node["id"] ?? "");
  const type = typeHint ?? detectNodeType(node);
  let label = String(node["title"] ?? node["path"] ?? node["name"] ?? "");
  if (type === "Turn" && node["userText"]) {
    label = String(node["userText"]).slice(0, 60);
  }
  if (!label) {
    label = id.slice(0, 8);
  }
  return { id, label, type, properties: node };
}

export function detectNodeType(node: Record<string, unknown>): string {
  if (node["remoteUrl"]) return "Project";
  if (node["path"] && !node["userText"]) return "File";
  if (node["kind"] !== undefined) return "Memory";
  if (node["status"] !== undefined && node["taskOrder"] !== undefined) return "Task";
  if (node["startedAt"] !== undefined) return "Session";
  if (node["userText"] !== undefined || node["assistantText"] !== undefined) return "Turn";
  return "Unknown";
}

export function parseNodeSelector(raw: string): NodeRef {
  const selector = raw.trim();
  if (!selector) throw new WalkError(400, "Start node id cannot be empty.");

  const splitAt = selector.indexOf(":");
  if (splitAt > 0) {
    const prefix = selector.slice(0, splitAt).trim();
    const rest = selector.slice(splitAt + 1).trim();
    if (rest) {
      return {
        id: rest,
        type: normalizeTypeLabel(prefix),
      };
    }
  }

  return { id: selector };
}

export function normalizeRelations(input?: string[] | "any"): string[] {
  if (!input || input === "any") {
    return [...DEFAULT_RELATIONS];
  }

  const list = Array.from(new Set(input.map((r) => r.trim()).filter(Boolean)));
  if (list.length === 0) return [...DEFAULT_RELATIONS];

  for (const rel of list) {
    if (!isSafeIdentifier(rel)) {
      throw new WalkError(400, `Invalid relation name \"${rel}\".`);
    }
  }

  return list;
}

function normalizeFilter(filter?: WalkFilter): Required<WalkFilter> {
  return {
    includeTypes: (filter?.includeTypes ?? []).map((t) => normalizeTypeLabel(t) ?? "").filter(Boolean),
    excludeTypes: (filter?.excludeTypes ?? []).map((t) => normalizeTypeLabel(t) ?? "").filter(Boolean),
    propertyPredicates: (filter?.propertyPredicates ?? []).filter((p) => p.key.trim() && p.value.trim()),
  };
}

function matchesNodeFilter(node: GraphNode, filter: Required<WalkFilter>): boolean {
  const nodeType = normalizeTypeLabel(node.type) ?? node.type;

  if (filter.includeTypes.length > 0 && !filter.includeTypes.includes(nodeType)) return false;
  if (filter.excludeTypes.includes(nodeType)) return false;

  for (const predicate of filter.propertyPredicates) {
    const actual = node.properties[predicate.key];
    if (actual === undefined || String(actual) !== predicate.value) {
      return false;
    }
  }

  return true;
}

export class WalkError extends Error {
  constructor(
    public readonly statusCode: 400 | 403 | 404,
    message: string
  ) {
    super(message);
    this.name = "WalkError";
  }
}

export interface NeighborFetcher {
  (
    node: GraphNode,
    relation: string,
    direction: "outbound" | "inbound"
  ): Promise<Array<{ node: GraphNode; properties: Record<string, unknown> }>>;
}

export async function traverseGraph(
  startNode: GraphNode,
  options: WalkOptions,
  fetchNeighbors: NeighborFetcher
): Promise<WalkTraversalResult> {
  const started = Date.now();
  const depth = Math.max(0, options.depth ?? 2);
  const strategy: WalkStrategy = options.strategy ?? "bfs";
  const direction: WalkDirection = options.direction ?? "outbound";
  const maxNodes = Math.max(1, options.maxNodes ?? 1000);
  const maxVisited = Math.max(maxNodes, options.maxVisited ?? 5000);
  const pageSize = Math.max(1, options.pageSize ?? maxNodes);
  const filter = normalizeFilter(options.filter);
  const relations = normalizeRelations(options.relations);
  const directions: Array<"outbound" | "inbound"> = direction === "both"
    ? ["outbound", "inbound"]
    : [direction];

  const frontier: Array<{ node: GraphNode; depth: number }> = [{ node: startNode, depth: 0 }];
  const visited = new Set<string>();
  const nodes: WalkResult[] = [];

  let truncationReason: WalkMetadata["truncationReason"];

  while (frontier.length > 0) {
    const current = strategy === "dfs" ? frontier.pop()! : frontier.shift()!;

    if (visited.has(current.node.id)) continue;
    if (visited.size >= maxVisited) {
      truncationReason = "maxVisited";
      break;
    }

    visited.add(current.node.id);

    const byRelation = new Map<string, WalkResult["relations"][number]["targets"]>();

    for (const relation of relations) {
      for (const relDirection of directions) {
        const targets = await fetchNeighbors(current.node, relation, relDirection);
        if (!byRelation.has(relation)) byRelation.set(relation, []);

        for (const target of targets) {
          if (matchesNodeFilter(target.node, filter)) {
            byRelation.get(relation)!.push(target);
          }
          if (current.depth < depth && !visited.has(target.node.id)) {
            frontier.push({ node: target.node, depth: current.depth + 1 });
          }
        }
      }
    }

    if (!matchesNodeFilter(current.node, filter)) continue;

    const relationsForNode: WalkResult["relations"] = [];
    for (const [type, targets] of byRelation.entries()) {
      if (targets.length > 0) {
        relationsForNode.push({ type, targets });
      }
    }

    nodes.push({
      node: current.node,
      relations: relationsForNode,
      depth: current.depth,
      isSeed: current.depth === 0,
    });

    if (nodes.length >= maxNodes) {
      truncationReason = "maxNodes";
      break;
    }
  }

  const metadata: WalkMetadata = {
    visitedCount: visited.size,
    emittedCount: nodes.length,
    durationMs: Date.now() - started,
    truncated: Boolean(truncationReason),
    truncationReason,
    pageSize,
  };

  return { nodes, metadata };
}

async function queryAllRows(
  conn: InstanceType<typeof kuzu.Connection>,
  cypher: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  return queryBuilder(conn).cypher(cypher).params(params).all();
}

async function findNodeByTypeAndId(
  conn: InstanceType<typeof kuzu.Connection>,
  type: string,
  id: string
): Promise<GraphNode | null> {
  if (!isSafeIdentifier(type)) {
    throw new WalkError(400, `Invalid start node type \"${type}\".`);
  }

  const rows = await queryAllRows(
    conn,
    `MATCH (n:${type}) WHERE n.id = $id RETURN n LIMIT 1`,
    { id }
  );
  if (rows.length > 0) {
    return nodeFromRecord(rows[0]["n"] as Record<string, unknown>, type);
  }

  const partialRows = await queryAllRows(
    conn,
    `MATCH (n:${type}) WHERE n.id CONTAINS $id RETURN n LIMIT 1`,
    { id }
  );
  if (partialRows.length > 0) {
    return nodeFromRecord(partialRows[0]["n"] as Record<string, unknown>, type);
  }

  if (TYPES_WITH_TITLE.has(type)) {
    const titleRows = await queryAllRows(
      conn,
      `MATCH (n:${type}) WHERE n.title CONTAINS $id RETURN n LIMIT 1`,
      { id }
    );
    if (titleRows.length > 0) {
      return nodeFromRecord(titleRows[0]["n"] as Record<string, unknown>, type);
    }
  }

  return null;
}

export async function resolveStartNode(
  conn: InstanceType<typeof kuzu.Connection>,
  input: WalkCliInput,
  fallbackToLatestSession = true
): Promise<ResolvedStartNode> {
  const legacyRef: NodeRef | undefined = input.sessionId
    ? { id: input.sessionId, type: "Session" }
    : input.taskId
      ? { id: input.taskId, type: "Task" }
      : undefined;

  const selectorRef = input.startId
    ? parseNodeSelector(input.startId)
    : input.id
      ? parseNodeSelector(input.id)
      : undefined;

  const requestedRef: NodeRef | undefined = input.startType
    ? { id: selectorRef?.id ?? input.startId ?? input.id ?? "", type: input.startType }
    : selectorRef ?? legacyRef;

  if (!requestedRef || !requestedRef.id) {
    if (!fallbackToLatestSession) {
      throw new WalkError(400, "A start node is required.");
    }

    const rows = await queryBuilder(conn)
      .cypher("MATCH (n:Session) RETURN n ORDER BY n.startedAt DESC LIMIT 1")
      .all();

    if (rows.length === 0) {
      throw new WalkError(404, "No nodes found to walk from.");
    }

    const node = nodeFromRecord(rows[0]["n"] as Record<string, unknown>, "Session");
    return {
      node,
      ref: { id: node.id, type: "Session" },
    };
  }

  const normalizedType = normalizeTypeLabel(requestedRef.type);

  if (normalizedType) {
    const node = await findNodeByTypeAndId(conn, normalizedType, requestedRef.id);
    if (!node) throw new WalkError(404, `Start node not found: ${normalizedType}:${requestedRef.id}`);
    return { node, ref: { id: node.id, type: normalizedType } };
  }

  for (const type of KNOWN_NODE_TYPES) {
    const node = await findNodeByTypeAndId(conn, type, requestedRef.id);
    if (node) {
      return { node, ref: { id: node.id, type } };
    }
  }

  throw new WalkError(404, `Start node not found: ${requestedRef.id}`);
}

export async function traverseDbGraph(
  conn: InstanceType<typeof kuzu.Connection>,
  startNode: GraphNode,
  options: WalkOptions
): Promise<WalkTraversalResult> {
  const fetchNeighbors: NeighborFetcher = async (node, relation, direction) => {
    if (!isSafeIdentifier(node.type) || !isSafeIdentifier(relation)) {
      throw new WalkError(400, "Invalid node type or relation identifier.");
    }

    const cypher = direction === "outbound"
      ? `MATCH (n:${node.type} {id: $id})-[r:${relation}]->(target) RETURN target, r`
      : `MATCH (target)-[r:${relation}]->(n:${node.type} {id: $id}) RETURN target, r`;

    try {
      const rows = await queryBuilder(conn)
        .cypher(cypher)
        .param("id", node.id)
        .all();

      return rows.map((row) => {
        const targetRaw = row["target"] as Record<string, unknown>;
        const relProps = (row["r"] as Record<string, unknown> | undefined) ?? {};
        return {
          node: nodeFromRecord(targetRaw),
          properties: relProps,
        };
      });
    } catch {
      return [];
    }
  };

  return traverseGraph(startNode, options, fetchNeighbors);
}
