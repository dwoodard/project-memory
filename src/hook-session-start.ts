#!/usr/bin/env node
/**
 * Claude Code SessionStart hook.
 * Fires when a new session opens. Writes a lean context bundle to stdout
 * so Claude Code injects it into the session before the first user message.
 *
 * Budget strategy (2000 char hard cap):
 *   1. Active task         — always include if present
 *   2. Pending tasks       — top 3
 *   3. Recent decisions    — top 3
 *   4. Key facts           — top 2
 *
 * Each section is truncated to fit. If nothing is in the DB, outputs nothing.
 */

import * as fs from "fs";
import { findProjectMemoryDir } from "./hook-utils.js";
import { readProjectConfig } from "./config.js";
import { getDb } from "./db.js";
import { queryAll } from "./kuzu-helpers.js";
import type { Memory } from "./types.js";

interface SessionStartPayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
}

const BUDGET = 2000;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function buildBundle(
  activeTask: Memory | null,
  pending: Memory[],
  decisions: Memory[],
  facts: Memory[]
): string {
  const lines: string[] = [];
  let remaining = BUDGET;

  const push = (line: string) => {
    if (remaining <= 0) return;
    const safe = truncate(line, remaining);
    lines.push(safe);
    remaining -= safe.length + 1; // +1 for newline
  };

  if (activeTask) {
    push(`## Active Task`);
    push(`${activeTask.title}`);
    if (activeTask.summary) push(activeTask.summary);
    push("");
  }

  if (pending.length > 0) {
    push(`## Pending Tasks`);
    for (const t of pending) push(`- ${t.title}`);
    push("");
  }

  if (decisions.length > 0) {
    push(`## Recent Decisions`);
    for (const d of decisions) push(`- **${d.title}**: ${d.summary}`);
    push("");
  }

  if (facts.length > 0) {
    push(`## Key Facts`);
    for (const f of facts) push(`- ${f.title}: ${f.summary}`);
  }

  return lines.join("\n").trim();
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = fs.readFileSync("/dev/stdin", "utf-8");
  } catch {
    process.exit(0);
  }

  let payload: SessionStartPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  try {
    const projectMemoryDir = findProjectMemoryDir(payload.cwd);
    if (!projectMemoryDir) process.exit(0);

    const config = readProjectConfig(projectMemoryDir);
    const { conn } = getDb(projectMemoryDir);
    const pid = config.projectId;

    const activeRows = await queryAll(conn,
      `MATCH (m:Memory {projectId: '${pid}', kind: 'task', status: 'active'})
       RETURN m ORDER BY m.createdAt DESC LIMIT 1`
    );
    const pendingRows = await queryAll(conn,
      `MATCH (m:Memory {projectId: '${pid}', kind: 'task', status: 'pending'})
       RETURN m ORDER BY m.createdAt ASC LIMIT 3`
    );
    const decisionRows = await queryAll(conn,
      `MATCH (m:Memory {projectId: '${pid}', kind: 'decision'})
       RETURN m ORDER BY m.createdAt DESC LIMIT 3`
    );
    const factRows = await queryAll(conn,
      `MATCH (m:Memory {projectId: '${pid}', kind: 'fact'})
       RETURN m ORDER BY m.createdAt DESC LIMIT 2`
    );

    const activeTask = activeRows[0]?.["m"] as Memory | undefined ?? null;
    const pending = pendingRows.map((r) => r["m"] as Memory);
    const decisions = decisionRows.map((r) => r["m"] as Memory);
    const facts = factRows.map((r) => r["m"] as Memory);

    if (!activeTask && pending.length === 0 && decisions.length === 0 && facts.length === 0) {
      process.exit(0);
    }

    const bundle = buildBundle(activeTask, pending, decisions, facts);
    if (bundle) process.stdout.write(bundle + "\n");
  } catch {
    // Never block session start
  }

  process.exit(0);
}

main();
