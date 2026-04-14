import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { Turn } from "./types.js";
import type { ProjectConfig } from "./config.js";
import type kuzu from "kuzu";
import { queryBuilder } from "./kuzu-helpers.js";
import { embed } from "./llm.js";
import { extractFilePaths } from "./db.js";

function langFromPath(p: string): string {
  const ext = p.split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx",
    py: "py", go: "go", rs: "rs", java: "java",
    md: "md", json: "json", yaml: "yaml", yml: "yaml",
  };
  return map[ext] ?? ext;
}

export type TurnEntry = {
  turnId: string;
  timestamp: string;
  messages: Array<{ role: string; content: string }>;
  files: string[];
  promptId?: string;
};

/**
 * Writes a turn to the session JSONL file and returns the entry.
 * Pure file I/O — no DB dependency. Call this first, before acquiring a DB connection.
 */
export function writeSessionLog(
  turn: Turn,
  projectMemoryDir: string,
  sessionId: string,
): TurnEntry {
  const sessionsDir = path.join(projectMemoryDir, "sessions");
  const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);

  const allText = turn.messages.map((m) => m.content).join(" ");
  const filePaths = extractFilePaths(allText);

  const entry: TurnEntry = {
    turnId: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
    timestamp: turn.timestamp,
    messages: turn.messages,
    files: filePaths,
    ...(turn.promptId ? { promptId: turn.promptId } : {}),
  };

  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.appendFileSync(sessionFile, JSON.stringify(entry) + "\n");

  return entry;
}

/**
 * Upserts a Turn node and its edges into the graph DB.
 * Fire-and-forget — errors are swallowed so they never block the caller.
 */
export function upsertTurnToGraph(
  conn: InstanceType<typeof kuzu.Connection>,
  entry: TurnEntry,
  sessionId: string,
  projectId: string,
): void {
  upsertTurnNode(conn, entry, sessionId, projectId).catch(() => {});
}

/** Convenience wrapper: writes JSONL then schedules the graph upsert. */
export function appendTurn(
  turn: Turn,
  projectMemoryDir: string,
  sessionId: string,
  conn?: InstanceType<typeof kuzu.Connection>,
  projectId?: string
): string {
  const entry = writeSessionLog(turn, projectMemoryDir, sessionId);
  if (conn && projectId) {
    upsertTurnToGraph(conn, entry, sessionId, projectId);
  }
  return entry.turnId;
}

async function upsertTurnNode(
  conn: InstanceType<typeof kuzu.Connection>,
  entry: { turnId: string; timestamp: string; messages: Array<{ role: string; content: string }>; files: string[] },
  sessionId: string,
  projectId: string
): Promise<void> {
  const userText = (entry.messages.find((m) => m.role === "user")?.content ?? "").slice(0, 400);
  const assistantText = (entry.messages.find((m) => m.role === "assistant")?.content ?? "").slice(0, 400);
  const filePaths = entry.files;

  // Create Turn node
  await queryBuilder(conn)
    .cypher(`CREATE (t:Turn {
      id: $id,
      sessionId: $sessionId,
      projectId: $projectId,
      timestamp: $timestamp,
      userText: $userText,
      assistantText: $assistantText,
      embedding: $embedding
    })`)
    .param("id", entry.turnId)
    .param("sessionId", sessionId)
    .param("projectId", projectId)
    .param("timestamp", entry.timestamp)
    .param("userText", userText)
    .param("assistantText", assistantText)
    .param("embedding", [])
    .count();

  // Count existing turns to assign a stable turnIndex
  const cntResult = await queryBuilder(conn)
    .cypher(`MATCH (s:Session {id: $sessionId})-[:HAS_TURN]->(t:Turn) RETURN count(t) AS cnt`)
    .param("sessionId", sessionId)
    .one();

  const turnIndex = Number(cntResult?.["cnt"] ?? 0);

  // Create HAS_TURN edge with index
  await queryBuilder(conn)
    .cypher(`MATCH (s:Session {id: $sessionId}), (t:Turn {id: $turnId})
             CREATE (s)-[:HAS_TURN {turnIndex: $turnIndex}]->(t)`)
    .param("sessionId", sessionId)
    .param("turnId", entry.turnId)
    .param("turnIndex", turnIndex)
    .count()
    .catch(() => {});

  // Upsert file nodes and create REFERENCES edges
  for (const fp of filePaths) {
    const fileId = `${projectId}:${fp}`;
    const lang = langFromPath(fp);
    const now = entry.timestamp;

    // Check if file exists
    const existing = await queryBuilder(conn)
      .cypher(`MATCH (f:File {id: $fileId}) RETURN f.id`)
      .param("fileId", fileId)
      .one();

    if (!existing) {
      // Create new File node
      await queryBuilder(conn)
        .cypher(`CREATE (f:File {id: $id, path: $path, projectId: $projectId, language: $language, lastSeenAt: $lastSeenAt})`)
        .param("id", fileId)
        .param("path", fp)
        .param("projectId", projectId)
        .param("language", lang)
        .param("lastSeenAt", now)
        .count()
        .catch(() => {});
    } else {
      // Update lastSeenAt
      await queryBuilder(conn)
        .cypher(`MATCH (f:File {id: $id}) SET f.lastSeenAt = $lastSeenAt`)
        .param("id", fileId)
        .param("lastSeenAt", now)
        .count()
        .catch(() => {});
    }

    // Create REFERENCES edge
    await queryBuilder(conn)
      .cypher(`MATCH (t:Turn {id: $turnId}), (f:File {id: $fileId})
               CREATE (t)-[:REFERENCES {accessType: 'read'}]->(f)`)
      .param("turnId", entry.turnId)
      .param("fileId", fileId)
      .count()
      .catch(() => {});
  }

  // Embed async
  const filesSuffix = filePaths.length > 0 ? `\nfiles: ${filePaths.join(", ")}` : "";
  const embedText = `user: ${userText}\nassistant: ${assistantText}${filesSuffix}`;
  embed(embedText).then((vec) => {
    queryBuilder(conn)
      .cypher(`MATCH (t:Turn {id: $id}) SET t.embedding = $embedding`)
      .param("id", entry.turnId)
      .param("embedding", vec)
      .count()
      .catch(() => {});
  }).catch(() => {});
}

export function resolveSession(
  turn: Turn,
  projectMemoryDir: string,
  config: ProjectConfig
): string {
  // Use the client-provided sessionId if present, otherwise derive one per day
  if (turn.sessionId) return turn.sessionId;

  const date = new Date(turn.timestamp).toISOString().slice(0, 10);
  return `${config.projectId}_${date}`;
}
