import * as fs from "fs";
import * as path from "path";
import type { Turn } from "./types.js";

export function getSummaryPath(
  projectMemoryDir: string,
  sessionId: string
): string {
  return path.join(projectMemoryDir, "summaries", `${sessionId}.md`);
}

export function readSummary(
  projectMemoryDir: string,
  sessionId: string
): string {
  const summaryPath = getSummaryPath(projectMemoryDir, sessionId);
  if (!fs.existsSync(summaryPath)) return "";
  return fs.readFileSync(summaryPath, "utf-8");
}

export function writeSummary(
  projectMemoryDir: string,
  sessionId: string,
  summary: string
): void {
  const summaryPath = getSummaryPath(projectMemoryDir, sessionId);
  fs.writeFileSync(summaryPath, summary);
}

export function buildUpdatedSummary(
  existingSummary: string,
  turn: Turn
): string {
  // This is called after extract-memory with the LLM-generated summary update.
  // For now, append a timestamped entry. The real update happens via the extraction prompt.
  const userMsg = turn.messages.find((m) => m.role === "user")?.content ?? "";
  const assistantMsg =
    turn.messages.find((m) => m.role === "assistant")?.content ?? "";

  const truncate = (s: string, n: number) =>
    s.length > n ? s.slice(0, n) + "..." : s;

  const newEntry = [
    `[${turn.timestamp}]`,
    `User: ${truncate(userMsg, 200)}`,
    `Assistant: ${truncate(assistantMsg, 200)}`,
  ].join("\n");

  if (!existingSummary) return newEntry;
  return existingSummary + "\n\n---\n\n" + newEntry;
}
