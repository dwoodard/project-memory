#!/usr/bin/env node
/**
 * Claude Code UserPromptSubmit hook.
 * Fires when the user submits a message, before Claude responds.
 * Extracts high-confidence memories directly from user text.
 * Payload: { session_id, cwd, prompt, hook_event_name }
 */

import * as fs from "fs";
import * as crypto from "crypto";
import { findProjectMemoryDir } from "./hook-utils.js";
import { extractFromUserMessage, writeCandidateFile } from "./extract-memory.js";
import { promoteToDb } from "./promote-memory.js";
import { readProjectConfig } from "./config.js";
import { getDb } from "./db.js";

interface UserPromptPayload {
  session_id: string;
  cwd: string;
  prompt: string;
  hook_event_name: string;
}

function stripSystemTags(text: string): string {
  return text
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "")
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = fs.readFileSync("/dev/stdin", "utf-8");
  } catch {
    process.exit(0);
  }

  let payload: UserPromptPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const userText = stripSystemTags(payload.prompt ?? "");
  if (!userText) process.exit(0);

  try {
    const projectMemoryDir = findProjectMemoryDir(payload.cwd);
    if (!projectMemoryDir) process.exit(0);

    const config = readProjectConfig(projectMemoryDir);
    if (!config.llm?.model || config.llm.model === "local-model") process.exit(0);

    const turnId = `turn_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const sessionId = payload.session_id;

    // Extract high-confidence memories from user message
    const candidates = await extractFromUserMessage(userText, sessionId, turnId);
    if (candidates.length === 0) process.exit(0);

    // Write to candidates folder
    writeCandidateFile(projectMemoryDir, candidates);

    // Promote directly to DB — user's own words are high confidence
    const { conn } = await getDb(projectMemoryDir);
    const promoted = await promoteToDb(candidates, config.projectId, conn);

    // promoted memories are persisted to Kuzu; no additional logging needed
  } catch {
    // Never block Claude
  }

  process.exit(0);
}

main();
