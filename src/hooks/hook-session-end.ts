#!/usr/bin/env node
/**
 * Claude Code SessionEnd hook.
 * Fires when a session terminates. Summarizes session, creates Memory node, and finalizes metadata.
 * Payload: { session_id, cwd, hook_event_name, reason }
 */

import * as fs from "fs";
import { execSync } from "child_process";
import { findProjectMemoryDir } from "./hook-utils.js";
import { readProjectConfig } from "../config.js";
import { getDb } from "../db.js";
import { escape } from "../kuzu-helpers.js";
import { summarizeSession } from "../extract-memory.js";
import { captureSessionSummary } from "../index.js";
import { readSessionTurns } from "../update-summary.js";

interface SessionEndPayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  reason?: string;
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = fs.readFileSync("/dev/stdin", "utf-8");
  } catch {
    process.exit(0);
  }

  let payload: SessionEndPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  try {
    const projectMemoryDir = findProjectMemoryDir(payload.cwd);
    if (!projectMemoryDir) process.exit(0);

    const config = readProjectConfig(projectMemoryDir);
    const { conn } = await getDb(projectMemoryDir);
    const sessionId = payload.session_id;
    const now = new Date().toISOString();

    // Generate title and summary from session turns
    const rawLog = readSessionTurns(projectMemoryDir, sessionId);
    if (rawLog && config.llm?.model && config.llm.model !== "local-model") {
      try {
        const { title, summary, tags } = await summarizeSession(rawLog, config.projectName);
        if (title || summary) {
          const setClause = [
            `s.title = '${escape(title)}'`,
            `s.summary = '${escape(summary)}'`,
            `s.endedAt = '${escape(now)}'`
          ];
          if (tags) setClause.push(`s.tags = '${escape(tags)}'`);

          await conn.query(
            `MATCH (s:Session {id: '${escape(sessionId)}'})
             SET ${setClause.join(', ')}`
          );
          // Close session with summarization
          if (summary) {
            try {
              execSync(`pensieve sessions -c --summarize "${summary.replace(/"/g, '\\"')}"`, { stdio: "pipe" });
            } catch {
              // Never block on sessions close
            }
          }
        } else {
          // No summary generated, just set end metadata
          await conn.query(
            `MATCH (s:Session {id: '${escape(sessionId)}'})
             SET s.endedAt = '${escape(now)}'`
          );
        }
      } catch {
        // If summarization fails, still set end metadata
        await conn.query(
          `MATCH (s:Session {id: '${escape(sessionId)}'})
           SET s.endedAt = '${escape(now)}'`
        );
      }
    } else {
      // No LLM or local model, just set end metadata
      await conn.query(
        `MATCH (s:Session {id: '${escape(sessionId)}'})
         SET s.endedAt = '${escape(now)}'`
      );
    }

    // Capture session summary as Memory node for AI planning context
    try {
      await captureSessionSummary(conn, sessionId, config.projectId);
    } catch {
      // Never block on memory capture
    }
  } catch {
    // Never block session end
  }

  process.exit(0);
}

main();
