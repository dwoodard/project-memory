#!/usr/bin/env node
/**
 * Claude Code Stop hook.
 * Extracts the last turn from the transcript and runs the full ingest pipeline
 * (turn log + memory extraction).
 */

import * as fs from "fs";
import * as path from "path";
import { ingestTurn } from "./index.js";
import { findProjectMemoryDir } from "./hook-utils.js";
import { getDb, applySchema } from "./db.js";
import { readProjectConfig } from "./config.js";
import { llmComplete } from "./llm.js";
import { queryAll } from "./kuzu-helpers.js";
import { escape as esc } from "./kuzu-helpers.js";
import type { Turn } from "./types.js";

interface HookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  stop_reason: string;
}

interface TranscriptEntry {
  parentUuid: string | null;
  promptId?: string;
  type?: string;
  message: {
    role: "user" | "assistant";
    content:
      | string
      | Array<{
          type: string;
          text?: string;
          tool_use_id?: string;
          content?: string;
        }>;
  };
  uuid: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
}

function stripSystemTags(text: string): string {
  return text
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "")
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractText(content: TranscriptEntry["message"]["content"]): string {
  if (typeof content === "string") return stripSystemTags(content);
  return stripSystemTags(
    content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("\n")
  );
}


async function main(): Promise<void> {
  let raw: string;
  try {
    raw = fs.readFileSync("/dev/stdin", "utf-8");
  } catch {
    process.exit(0);
  }

  let payload: HookPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  if (!payload.transcript_path || !fs.existsSync(payload.transcript_path)) {
    process.exit(0);
  }

  try {
    const entries: TranscriptEntry[] = fs
      .readFileSync(payload.transcript_path, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));

    // Find the last promptId that has a real user text message
    let lastPromptId: string | null = null;
    let lastRoot: TranscriptEntry | null = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (!e.promptId || e.message.role !== "user") continue;
      const text = extractText(e.message.content);
      if (text) {
        lastPromptId = e.promptId;
        lastRoot = e;
        break;
      }
    }

    if (!lastPromptId || !lastRoot) process.exit(0);

    const userText = extractText(lastRoot.message.content);
    if (!userText) process.exit(0);

    // Assistant messages have no promptId — find them via parentUuid chain.
    // Collect all uuids that belong to this prompt's user messages.
    const promptUuids = new Set(
      entries.filter((e) => e.promptId === lastPromptId).map((e) => e.uuid)
    );
    // Walk backwards and find the last assistant message whose parentUuid
    // points to one of those uuids.
    let assistantText = "";
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.message.role !== "assistant") continue;
      if (!e.parentUuid || !promptUuids.has(e.parentUuid)) continue;
      const text = extractText(e.message.content);
      if (text) { assistantText = text; break; }
    }

    const cwd = lastRoot.cwd ?? payload.cwd;
    const sessionId = lastRoot.sessionId ?? payload.session_id;
    const timestamp = lastRoot.timestamp ?? new Date().toISOString();

    const projectMemoryDir = findProjectMemoryDir(cwd);
    if (!projectMemoryDir) process.exit(0);

    // Run full ingest pipeline with LLM extraction
    const turn: Turn = {
      client: "claude-code",
      cwd,
      sessionId,
      timestamp,
      messages: [
        { role: "user", content: userText },
        { role: "assistant", content: assistantText },
      ],
      files: [],
    };

    // No LLM extraction — just log the turn and update the rolling summary
    await ingestTurn(turn);

    // Optionally update project description based on what happened this session
    try {
      const projectMemoryDir2 = findProjectMemoryDir(cwd);
      if (projectMemoryDir2) {
        const config = readProjectConfig(projectMemoryDir2);
        const { conn: conn2 } = await getDb(projectMemoryDir2);
        await applySchema(conn2, projectMemoryDir2);
        const pid = config.projectId;

        const rows = await queryAll(conn2, `MATCH (p:Project {id: '${pid}'}) RETURN p`);
        const p = rows[0]?.["p"] as Record<string, unknown> | undefined;
        const current = p?.["description"] ? String(p["description"]) : "";

        const prompt = `You are maintaining a living project description for a software project called "${config.projectName}".

Current description:
${current || "(none yet)"}

What just happened in this session (user message):
${userText.slice(0, 800)}

Assistant response summary:
${assistantText.slice(0, 800)}

Task: Should the project description be updated based on this session? If yes, write a concise updated description (2-5 sentences) that captures what this project is, what it does, and any key characteristics. If no update is needed, respond with exactly: NO_UPDATE

Respond with either the new description text, or NO_UPDATE.`;

        const result = await llmComplete(prompt);
        const trimmed = result.trim();
        if (trimmed && trimmed !== "NO_UPDATE" && trimmed.length > 10) {
          await conn2.query(
            `MATCH (p:Project {id: '${esc(pid)}'}) SET p.description = '${esc(trimmed)}'`
          );
        }
      }
    } catch {
      // Never block Claude on description update errors
    }
  } catch {
    // Never block Claude on hook errors
  }

  process.exit(0);
}

main();
