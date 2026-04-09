import * as path from "path";
import { detectProject } from "./detect-project.js";
import { getDb } from "./db.js";
import { queryAll, escape } from "./kuzu-helpers.js";
import { appendTurn, resolveSession } from "./append-turn.js";
import { readSummary, writeSummary, buildUpdatedSummary, readSessionTurns } from "./update-summary.js";
import { extractFromTurn, writeCandidateFile, summarizeSession } from "./extract-memory.js";
import { promoteToDb } from "./promote-memory.js";
import { readProjectConfig } from "./config.js";
import { embed } from "./llm.js";
import type { Turn } from "./types.js";

export async function ingestTurn(turn: Turn): Promise<void> {
  const detected = detectProject(turn.cwd);
  if (!detected) {
    console.error("No pensieve project found at:", turn.cwd);
    return;
  }

  const { projectRoot } = detected;
  const projectMemoryDir = path.join(projectRoot, ".pensieve");
  let config;
  try {
    config = readProjectConfig(projectMemoryDir);
  } catch {
    console.error("Project not initialized. Run: pensieve init");
    return;
  }
  const { conn } = await getDb(projectMemoryDir);

  // 1. Resolve session
  const sessionId = resolveSession(turn, projectMemoryDir, config);

  const userText = turn.messages.find((m) => m.role === "user")?.content ?? "";

  // Ensure session exists in DB
  const sessionRows = await queryAll(
    conn,
    `MATCH (s:Session {id: '${sessionId}'}) RETURN s`
  );
  const isNewSession = sessionRows.length === 0;

  // Derive title from first user message (strip tags, truncate)
  function deriveTitle(text: string): string {
    const clean = text
      .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return clean.length > 80 ? clean.slice(0, 79) + "…" : clean;
  }

  if (isNewSession) {
    const title = deriveTitle(userText);
    await conn.query(
      `CREATE (s:Session {
        id: '${escape(sessionId)}',
        projectId: '${escape(config.projectId)}',
        startedAt: '${new Date().toISOString()}',
        title: '${escape(title)}',
        summary: ''
      })`
    );
    await conn.query(
      `MATCH (p:Project {id: '${escape(config.projectId)}'}), (s:Session {id: '${escape(sessionId)}'})
       CREATE (p)-[:HAS_SESSION]->(s)`
    );

    // Best-effort embedding of session title
    embed(title).then((vec) => {
      const literal = `[${vec.join(", ")}]`;
      conn.query(`MATCH (s:Session {id: '${escape(sessionId)}'}) SET s.embedding = ${literal}`).catch(() => {});
    }).catch(() => {});
  }

  // 2. Append turn to session log
  const turnId = appendTurn(turn, projectMemoryDir, sessionId, conn, config.projectId);

  // 3. Update rolling session summary — write to file and sync to Kuzu
  const existingSummary = readSummary(projectMemoryDir, sessionId);
  const updatedSummary = buildUpdatedSummary(existingSummary, turn);
  writeSummary(projectMemoryDir, sessionId, updatedSummary);
  await conn.query(
    `MATCH (s:Session {id: '${escape(sessionId)}'})
     SET s.summary = '${escape(updatedSummary)}'`
  );

  // 4. Extract memories from the full turn (skip if LLM not configured)
  if (!config.llm?.model || config.llm.model === "local-model") return;

  // 4a. Update session title/summary using the full session log (fire and forget)
  const fullLog = readSessionTurns(projectMemoryDir, sessionId);
  if (fullLog) {
    summarizeSession(fullLog, config.projectName).then(({ title, summary }) => {
      if (title) {
        conn.query(
          `MATCH (s:Session {id: '${escape(sessionId)}'})
           SET s.title = '${escape(title)}', s.summary = '${escape(summary)}'`
        ).catch(() => {});
      }
    }).catch(() => {});
  }

  const assistantText = turn.messages.find((m) => m.role === "assistant")?.content ?? "";
  if (!userText) return;

  try {
    const extractTurnId = `turn_${sessionId.slice(0, 8)}_${Date.now()}`;
    const candidates = await extractFromTurn(userText, assistantText, sessionId, extractTurnId);
    if (candidates.length === 0) return;

    writeCandidateFile(projectMemoryDir, candidates);
    await promoteToDb(candidates, config.projectId, conn, {
      turnId,
      embeddingModel: config.embedding?.model ?? "",
    });
  } catch {
    // Never block on extraction errors
  }
}
