#!/usr/bin/env node
/**
 * Claude Code PreCompact hook.
 * Fires when context is about to be compacted — natural end-of-session moment.
 * Reviews all accumulated candidates against the DB and promotes the best ones.
 * Payload: { session_id, cwd, hook_event_name, compaction_type }
 */

import * as fs from "fs";
import { findProjectMemoryDir } from "./hook-utils.js";
import { readAllCandidates, reviewCandidates, clearCandidates, summarizeSession, reviewTaskCompletion } from "./extract-memory.js";
import { promoteToDb, getExistingMemories } from "./promote-memory.js";
import { readProjectConfig } from "./config.js";
import { getDb } from "./db.js";
import { readSessionTurns } from "./update-summary.js";
import { escape, queryAll } from "./kuzu-helpers.js";
import type { Task } from "./types.js";

interface CompactPayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  compaction_type?: string;
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = fs.readFileSync("/dev/stdin", "utf-8");
  } catch {
    process.exit(0);
  }

  let payload: CompactPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  try {
    const projectMemoryDir = findProjectMemoryDir(payload.cwd);
    if (!projectMemoryDir) process.exit(0);

    const config = readProjectConfig(projectMemoryDir);
    if (!config.llm?.model || config.llm.model === "local-model") process.exit(0);

    const { conn } = await getDb(projectMemoryDir);
    const sessionId = payload.session_id;

    // Generate a meaningful title and summary for this session
    const rawLog = readSessionTurns(projectMemoryDir, sessionId);
    let sessionSummary = "";
    if (rawLog) {
      try {
        const { title, summary } = await summarizeSession(rawLog, config.projectName);
        sessionSummary = summary;
        if (title || summary) {
          await conn.query(
            `MATCH (s:Session {id: '${escape(sessionId)}'})
             SET s.title = '${escape(title)}', s.summary = '${escape(summary)}'`
          );
        }
      } catch {
        // Don't block on summarization failure
      }
    }

    // Review open tasks for completion based on session summary
    if (sessionSummary) {
      try {
        const openRows = await queryAll(conn,
          `MATCH (t:Task {projectId: '${escape(config.projectId)}'})
           WHERE t.status = 'pending' OR t.status = 'active' OR t.status = 'blocked'
           RETURN t ORDER BY t.taskOrder ASC`);
        const openTasks = openRows.map((r) => r["t"] as Task);
        if (openTasks.length > 0) {
          const suggestions = await reviewTaskCompletion(sessionSummary, openTasks);
          for (const { id, reason } of suggestions) {
            await conn.query(
              `MATCH (t:Task {id: '${escape(id)}'})
               SET t.doneSuggestion = '${escape(reason)}'`
            );
          }
        }
      } catch {
        // Never block compaction
      }
    }

    // Review and promote accumulated memory candidates
    const candidates = readAllCandidates(projectMemoryDir);
    if (candidates.length === 0) process.exit(0);

    // Get existing memories for deduplication
    const existing = await getExistingMemories(config.projectId, conn);

    // LLM reviews candidates against existing DB — promotes, merges, or discards
    const reviewed = await reviewCandidates(candidates, existing, config.projectName);

    if (reviewed.length > 0) {
      await promoteToDb(reviewed, config.projectId, conn);
    }

    // Clear candidates now that they've been reviewed
    clearCandidates(projectMemoryDir);
  } catch {
    // Never block compaction
  }

  process.exit(0);
}

main();
