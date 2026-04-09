import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { Turn } from "./types.js";
import type { ProjectConfig } from "./config.js";
import type kuzu from "kuzu";
import { escape } from "./kuzu-helpers.js";
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

export function appendTurn(
  turn: Turn,
  projectMemoryDir: string,
  sessionId: string,
  conn: InstanceType<typeof kuzu.Connection>,
  projectId: string
): string {
  const sessionsDir = path.join(projectMemoryDir, "sessions");
  const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);

  const allText = turn.messages.map((m) => m.content).join(" ");
  const filePaths = extractFilePaths(allText);

  const entry = {
    turnId: `turn_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    timestamp: turn.timestamp,
    messages: turn.messages,
    files: filePaths,
  };

  fs.appendFileSync(sessionFile, JSON.stringify(entry) + "\n");

  // Upsert Turn node and related graph edges — fire and forget
  upsertTurnNode(conn, entry, sessionId, projectId).catch(() => {});

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

  await conn.query(
    `CREATE (t:Turn {
      id: '${escape(entry.turnId)}',
      sessionId: '${escape(sessionId)}',
      projectId: '${escape(projectId)}',
      timestamp: '${escape(entry.timestamp)}',
      userText: '${escape(userText)}',
      assistantText: '${escape(assistantText)}',
      embedding: []
    })`
  );

  // Count existing turns to assign a stable turnIndex
  const cntResult = await conn.query(
    `MATCH (s:Session {id: '${escape(sessionId)}'})-[:HAS_TURN]->(t:Turn) RETURN count(t) AS cnt`
  );
  const cntQr = Array.isArray(cntResult) ? cntResult[0] : cntResult;
  const cntRows = await (cntQr as { getAll(): Promise<Record<string, unknown>[]> }).getAll();
  const turnIndex = Number(cntRows[0]?.["cnt"] ?? 0);

  await conn.query(
    `MATCH (s:Session {id: '${escape(sessionId)}'}), (t:Turn {id: '${escape(entry.turnId)}'})
     CREATE (s)-[:HAS_TURN {turnIndex: ${turnIndex}}]->(t)`
  ).catch(() => {});

  for (const fp of filePaths) {
    const fileId = `${projectId}:${fp}`;
    const lang = langFromPath(fp);
    const now = entry.timestamp;

    const chk = await conn.query(`MATCH (f:File {id: '${escape(fileId)}'}) RETURN f.id`);
    const cqr = Array.isArray(chk) ? chk[0] : chk;
    const crow = await (cqr as { getAll(): Promise<Record<string, unknown>[]> }).getAll();
    if (crow.length === 0) {
      await conn.query(
        `CREATE (f:File {id: '${escape(fileId)}', path: '${escape(fp)}',
          projectId: '${escape(projectId)}', language: '${escape(lang)}',
          lastSeenAt: '${escape(now)}'})`
      ).catch(() => {});
    } else {
      await conn.query(
        `MATCH (f:File {id: '${escape(fileId)}'}) SET f.lastSeenAt = '${escape(now)}'`
      ).catch(() => {});
    }

    await conn.query(
      `MATCH (t:Turn {id: '${escape(entry.turnId)}'}), (f:File {id: '${escape(fileId)}'})
       CREATE (t)-[:REFERENCES {accessType: 'read'}]->(f)`
    ).catch(() => {});
  }

  // Embed async
  const filesSuffix = filePaths.length > 0 ? `\nfiles: ${filePaths.join(", ")}` : "";
  const embedText = `user: ${userText}\nassistant: ${assistantText}${filesSuffix}`;
  embed(embedText).then((vec) => {
    const literal = `[${vec.join(", ")}]`;
    conn.query(`MATCH (t:Turn {id: '${escape(entry.turnId)}'}) SET t.embedding = ${literal}`).catch(() => {});
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
