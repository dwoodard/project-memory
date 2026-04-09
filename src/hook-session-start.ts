#!/usr/bin/env node
/**
 * Claude Code SessionStart hook.
 * Fires when a new session opens. Writes a lean context bundle to stdout
 * so Claude Code injects it into the session before the first user message.
 */

import * as fs from "fs";
import { findProjectMemoryDir } from "./hook-utils.js";
import { readProjectConfig } from "./config.js";
import { getDb } from "./db.js";
import { querySessionBundle } from "./session-bundle.js";

interface SessionStartPayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
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
    const { conn } = await getDb(projectMemoryDir);

    const bundle = await querySessionBundle(conn, config.projectId, payload.session_id);
    if (bundle) process.stdout.write(bundle + "\n");
  } catch {
    // Never block session start
  }

  process.exit(0);
}

main();
