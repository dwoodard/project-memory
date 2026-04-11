import * as fs from "fs";
import * as path from "path";
import type { Turn } from "./types.js";

/**
 * Reads the full JSONL session file and returns a formatted conversation log
 * suitable for LLM summarization. Truncates to avoid token overflow.
 */
export function readSessionTurns(
  projectMemoryDir: string,
  sessionId: string,
  maxChars = 8000
): string {
  const sessionFile = path.join(projectMemoryDir, "sessions", `${sessionId}.jsonl`);
  if (!fs.existsSync(sessionFile)) return "";

  const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n").filter(Boolean);
  const parts: string[] = [];
  let total = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as {
        timestamp: string;
        messages: Array<{ role: string; content: string }>;
      };
      const user = entry.messages.find((m) => m.role === "user")?.content ?? "";
      const assistant = entry.messages.find((m) => m.role === "assistant")?.content ?? "";
      const chunk = `[${entry.timestamp}]\nUser: ${user}\nAssistant: ${assistant}`;
      if (total + chunk.length > maxChars) {
        parts.push("...[truncated]");
        break;
      }
      parts.push(chunk);
      total += chunk.length;
    } catch {
      // skip malformed lines
    }
  }

  return parts.join("\n\n---\n\n");
}

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
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, summary);
}

function stripTags(text: string): string {
  return text
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "")
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildUpdatedSummary(
  existingSummary: string,
  turn: Turn
): string {
  const userMsg = stripTags(turn.messages.find((m) => m.role === "user")?.content ?? "");
  const assistantMsg = stripTags(
    turn.messages.find((m) => m.role === "assistant")?.content ?? ""
  );

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
