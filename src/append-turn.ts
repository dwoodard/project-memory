import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { Turn, ProjectConfig } from "./types.js";

export function appendTurn(
  turn: Turn,
  projectMemoryDir: string,
  sessionId: string
): string {
  const sessionsDir = path.join(projectMemoryDir, "sessions");
  const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);

  const entry = {
    turnId: `turn_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    timestamp: turn.timestamp,
    messages: turn.messages,
    files: turn.files ?? [],
  };

  fs.appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
  return entry.turnId;
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
