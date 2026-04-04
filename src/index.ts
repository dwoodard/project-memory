import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { detectProject } from "./detect-project.js";
import { getDb } from "./db.js";
import { queryAll } from "./kuzu-helpers.js";
import { appendTurn, resolveSession } from "./append-turn.js";
import {
  buildExtractionPrompt,
  parseCandidates,
  writeCandidates,
} from "./extract-memory.js";
import { promoteMemories } from "./promote-memory.js";
import { readSummary, writeSummary, buildUpdatedSummary } from "./update-summary.js";
import type { Turn, ProjectConfig } from "./types.js";

export async function ingestTurn(
  turn: Turn,
  extractFn?: (prompt: string) => Promise<string>
): Promise<void> {
  const detected = detectProject(turn.cwd);
  if (!detected) {
    console.error("No git repo found at:", turn.cwd);
    return;
  }

  const { repoRoot } = detected;
  const projectMemoryDir = path.join(repoRoot, ".project-memory");
  const configPath = path.join(projectMemoryDir, "config.json");

  if (!fs.existsSync(configPath)) {
    console.error(
      "Project not initialized. Run: project-memory init"
    );
    return;
  }

  const config: ProjectConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const { conn } = getDb(projectMemoryDir);

  // 1. Resolve session
  const sessionId = resolveSession(turn, projectMemoryDir, config);

  // Ensure session exists in DB
  const sessionRows = await queryAll(
    conn,
    `MATCH (s:Session {id: '${sessionId}'}) RETURN s`
  );
  if (sessionRows.length === 0) {
    await conn.query(
      `CREATE (s:Session {
        id: '${sessionId}',
        projectId: '${config.projectId}',
        startedAt: '${new Date().toISOString()}',
        summary: ''
      })`
    );
    await conn.query(
      `MATCH (p:Project {id: '${config.projectId}'}), (s:Session {id: '${sessionId}'})
       CREATE (p)-[:HAS_SESSION]->(s)`
    );
  }

  // 2. Append turn to session log
  const turnId = appendTurn(turn, projectMemoryDir, sessionId);

  // 3. Read existing session summary
  const existingSummary = readSummary(projectMemoryDir, sessionId);

  // 4. Extract candidate memories (if extraction function provided)
  if (extractFn) {
    const prompt = buildExtractionPrompt(
      turn,
      existingSummary,
      config.projectName
    );

    try {
      const response = await extractFn(prompt);
      const candidates = parseCandidates(response);

      if (candidates.length > 0) {
        writeCandidates(candidates, projectMemoryDir, sessionId, turnId);
        const promoted = await promoteMemories(
          candidates,
          sessionId,
          config,
          conn
        );
        if (promoted.length > 0) {
          console.log(
            `Promoted ${promoted.length} memory(s):`,
            promoted.map((m) => `[${m.kind}] ${m.title}`).join(", ")
          );
        }
      }
    } catch (err) {
      console.error("Memory extraction failed:", err);
    }
  }

  // 5. Update rolling session summary
  const updatedSummary = buildUpdatedSummary(existingSummary, turn);
  writeSummary(projectMemoryDir, sessionId, updatedSummary);
}
