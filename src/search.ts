import { embed } from "./llm.js";
import { queryAll, escape } from "./kuzu-helpers.js";
import type { Memory, Task, Session, TurnNode, ScoredMemory } from "./types.js";
import type kuzu from "kuzu";

export { ScoredMemory };

export interface ScoredNode {
  id: string;
  nodeType: "memory" | "task" | "session" | "turn";
  title: string;
  summary: string;
  score: number;
  projectId: string;
  // memory-specific
  kind?: string;
  recallCue?: string;
  sessionId?: string;
  createdAt?: string;
  // task-specific
  status?: string;
  taskOrder?: number;
  parentId?: string;
  // session-specific
  startedAt?: string;
  // graph-walk context
  sessionTitle?: string;
  sessionSummary?: string;
  // co-session memories surfaced alongside this result
  breadcrumbs?: ScoredNode[];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Exponential recency decay — score of 1.0 today, ~0.5 at halfLifeDays */
function recencyScore(createdAt: string, halfLifeDays = 14): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

// ── Row → ScoredNode helpers ────────────────────────────────────────────────

function memoryNode(m: Memory & { embedding: number[] }, queryVec: number[], weight = 1): ScoredNode {
  return {
    nodeType: "memory", id: m.id, title: m.title, summary: m.summary,
    projectId: m.projectId, score: cosineSimilarity(queryVec, m.embedding) * weight,
    kind: m.kind, recallCue: m.recallCue, sessionId: m.sessionId, createdAt: m.createdAt,
  };
}

function turnNode(t: TurnNode & { embedding: number[] }, queryVec: number[], weight = 1): ScoredNode {
  return {
    nodeType: "turn", id: t.id, title: t.userText.slice(0, 80),
    summary: t.assistantText.slice(0, 160), projectId: t.projectId,
    score: cosineSimilarity(queryVec, t.embedding) * weight,
    sessionId: t.sessionId, createdAt: t.timestamp,
  };
}

// ── Queries ─────────────────────────────────────────────────────────────────

async function loadMemories(conn: InstanceType<typeof kuzu.Connection>, projectId: string) {
  return queryAll(conn,
    `MATCH (m:Memory {projectId: '${escape(projectId)}'}) WHERE size(m.embedding) > 0 RETURN m`
  );
}

async function loadTurns(conn: InstanceType<typeof kuzu.Connection>, projectId: string) {
  return queryAll(conn,
    `MATCH (t:Turn {projectId: '${escape(projectId)}'}) WHERE size(t.embedding) > 0 RETURN t`
  );
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Unified flat vector search across all node types */
export async function searchAll(
  conn: InstanceType<typeof kuzu.Connection>,
  projectId: string,
  query: string,
  topK = 5
): Promise<ScoredNode[]> {
  const pid = escape(projectId);
  const [queryVec, memRows, taskRows, sessionRows, turnRows] = await Promise.all([
    embed(query),
    queryAll(conn, `MATCH (m:Memory {projectId: '${pid}'}) WHERE size(m.embedding) > 0 RETURN m`),
    queryAll(conn, `MATCH (t:Task {projectId: '${pid}'}) WHERE size(t.embedding) > 0 RETURN t`),
    queryAll(conn, `MATCH (s:Session {projectId: '${pid}'}) WHERE size(s.embedding) > 0 RETURN s`),
    queryAll(conn, `MATCH (t:Turn {projectId: '${pid}'}) WHERE size(t.embedding) > 0 RETURN t`),
  ]);

  const results: ScoredNode[] = [
    ...memRows.map((r) => memoryNode(r["m"] as Memory & { embedding: number[] }, queryVec)),
    ...taskRows.map((r) => {
      const t = r["t"] as Task & { embedding: number[] };
      return {
        nodeType: "task" as const, id: t.id, title: t.title, summary: t.summary,
        projectId: t.projectId, score: cosineSimilarity(queryVec, t.embedding),
        status: t.status, taskOrder: t.taskOrder, parentId: t.parentId, createdAt: t.createdAt,
      };
    }),
    ...sessionRows.map((r) => {
      const s = r["s"] as Session & { embedding: number[] };
      return {
        nodeType: "session" as const, id: s.id, title: (s.title ?? s.summary ?? "Untitled Session").slice(0, 80), summary: s.summary,
        projectId: s.projectId, score: cosineSimilarity(queryVec, s.embedding),
        startedAt: s.startedAt,
      };
    }),
    ...turnRows.map((r) => turnNode(r["t"] as TurnNode & { embedding: number[] }, queryVec)),
  ];

  return results.sort((a, b) => b.score - a.score).slice(0, topK);
}

/**
 * Graph-walk retrieval:
 * 1. Embed the seed query
 * 2. Score all Memory + Turn nodes: similarity × recency decay
 * 3. Take top seedK hits as entry points
 * 4. Walk to parent session → pull sibling memories + turns (half weight)
 * 5. Walk RELATED_TO edges on memory seeds (half weight)
 * 6. Deduplicate, re-rank, return topK
 */
export async function searchGraph(
  conn: InstanceType<typeof kuzu.Connection>,
  projectId: string,
  query: string,
  topK = 8,
  seedK = 4,
  embedFn: (text: string) => Promise<number[]> = embed
): Promise<ScoredNode[]> {
  const [queryVec, memRows, turnRows] = await Promise.all([
    embedFn(query),
    loadMemories(conn, projectId),
    loadTurns(conn, projectId),
  ]);

  const scored: ScoredNode[] = [
    ...memRows.map((r) => {
      const m = r["m"] as Memory & { embedding: number[] };
      return memoryNode(m, queryVec, recencyScore(m.createdAt));
    }),
    ...turnRows.map((r) => {
      const t = r["t"] as TurnNode & { embedding: number[] };
      return turnNode(t, queryVec, recencyScore(t.timestamp));
    }),
  ];

  if (scored.length === 0) return [];

  scored.sort((a, b) => b.score - a.score);
  const seeds = scored.slice(0, seedK);

  const candidates = new Map<string, ScoredNode>(seeds.map((s) => [s.id, s]));
  // Track sibling memories per seed for breadcrumb attachment (unweighted scores)
  const breadcrumbsBySeed = new Map<string, ScoredNode[]>();

  await Promise.all(seeds.map(async (seed) => {
    const rel = seed.nodeType === "memory" ? "HAS_MEMORY" : "HAS_TURN";
    const nodeLabel = seed.nodeType === "memory" ? "Memory" : "Turn";

    const sessionRows = await queryAll(conn,
      `MATCH (s:Session)-[:${rel}]->(n:${nodeLabel} {id: '${escape(seed.id)}'})
       RETURN s.id AS sid, s.title AS stitle, s.summary AS ssummary`);

    await Promise.all(sessionRows.map(async (sr) => {
      const sid = String(sr["sid"]);
      const stitle = String(sr["stitle"] ?? "");
      const ssummary = String(sr["ssummary"] ?? "");

      if (!candidates.get(seed.id)?.sessionTitle) {
        candidates.set(seed.id, { ...candidates.get(seed.id)!, sessionTitle: stitle, sessionSummary: ssummary });
      }

      const [sibMemRows, sibTurnRows] = await Promise.all([
        queryAll(conn,
          `MATCH (s:Session {id: '${escape(sid)}'})-[:HAS_MEMORY]->(m:Memory)
           WHERE m.id <> '${escape(seed.id)}' AND size(m.embedding) > 0 RETURN m`),
        queryAll(conn,
          `MATCH (s:Session {id: '${escape(sid)}'})-[:HAS_TURN]->(t:Turn)
           WHERE t.id <> '${escape(seed.id)}' AND size(t.embedding) > 0 RETURN t`),
      ]);

      for (const r of sibMemRows) {
        const m = r["m"] as Memory & { embedding: number[] };
        // Track at full score for breadcrumbs (before weight reduction)
        const fullScoreNode: ScoredNode = {
          ...memoryNode(m, queryVec, recencyScore(m.createdAt)),
          sessionTitle: stitle, sessionSummary: ssummary,
        };
        if (!breadcrumbsBySeed.has(seed.id)) breadcrumbsBySeed.set(seed.id, []);
        breadcrumbsBySeed.get(seed.id)!.push(fullScoreNode);
        if (candidates.has(m.id)) continue;
        candidates.set(m.id, { ...fullScoreNode, score: fullScoreNode.score * 0.5 });
      }

      for (const r of sibTurnRows) {
        const t = r["t"] as TurnNode & { embedding: number[] };
        if (candidates.has(t.id)) continue;
        candidates.set(t.id, turnNode(t, queryVec, recencyScore(t.timestamp) * 0.5));
      }
    }));

    // Walk RELATED_TO edges (memory seeds only)
    if (seed.nodeType === "memory") {
      const relRows = await queryAll(conn,
        `MATCH (m:Memory {id: '${escape(seed.id)}'})-[:RELATED_TO]->(rel:Memory)
         WHERE size(rel.embedding) > 0 RETURN rel`);
      for (const rr of relRows) {
        const rel = rr["rel"] as Memory & { embedding: number[] };
        if (candidates.has(rel.id)) continue;
        candidates.set(rel.id, memoryNode(rel, queryVec, recencyScore(rel.createdAt) * 0.5));
      }
    }
  }));

  const topResults = Array.from(candidates.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const topKIds = new Set(topResults.map((r) => r.id));
  for (const result of topResults) {
    const crumbs = breadcrumbsBySeed.get(result.id);
    if (crumbs && crumbs.length > 0) {
      result.breadcrumbs = crumbs
        .filter((c) => !topKIds.has(c.id))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
    }
  }

  return topResults;
}
