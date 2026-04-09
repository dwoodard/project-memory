/**
 * LLM-based memory extraction.
 * Used by both UserPromptSubmit (user text only) and PreCompact (full candidates review).
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { llmComplete } from "./llm.js";
import type { Memory, MemoryKind, Task, TaskStatus } from "./types.js";

export interface CandidateMemory {
  id: string;
  sessionId: string;
  turnId: string;
  createdAt: string;
  kind: MemoryKind;
  title: string;
  summary: string;
  recallCue: string;
  status?: TaskStatus;
}

// ─── Prompts ────────────────────────────────────────────────────────────────

const USER_PROMPT_EXTRACT = `You are a memory extraction system for an AI coding assistant.

A user just sent this message:
---
{USER_TEXT}
---

Does this message contain anything worth remembering long-term?
Only extract if the user is clearly stating:
- a decision that was made
- a task or next step
- an open question or blocker
- a fact about the project

Do NOT extract:
- questions to the assistant
- casual conversation
- requests for help
- anything that is not a clear statement from the user

Respond with a JSON array of 0-2 memory objects. Nothing else.
If nothing is worth keeping respond with: []

[
  {
    "kind": "decision" | "task" | "question" | "fact",
    "title": "short title",
    "summary": "one sentence",
    "recallCue": "when is this useful",
    "status": "pending" | "active" | null
  }
]`;

const TURN_EXTRACT_PROMPT = `You are a memory extraction system for an AI coding assistant.

Here is a completed conversation turn:
--- USER ---
{USER_TEXT}
--- ASSISTANT ---
{ASSISTANT_TEXT}
---

Extract 0-3 memories worth keeping long-term. Only extract:
- decisions made (e.g. "we decided to use X")
- tasks created or completed (e.g. "next step: implement Y")
- open questions or blockers (e.g. "still need to figure out Z")
- facts about the project (e.g. "the DB schema is at path X")

Do NOT extract:
- vague or conversational exchanges
- anything already obvious from the code
- the assistant's explanations or instructions

Respond with a JSON array. Nothing else.
If nothing is worth keeping respond with: []

[
  {
    "kind": "decision" | "task" | "question" | "fact",
    "title": "short title",
    "summary": "one sentence",
    "recallCue": "when is this useful",
    "status": "pending" | "active" | "done" | null
  }
]`;

const COMPACT_REVIEW_PROMPT = `You are a memory vetting system for an AI coding assistant.

Project: {PROJECT_NAME}

Here are candidate memories collected during this session:
---
{CANDIDATES}
---

Here are memories already in the database (do not duplicate):
---
{EXISTING}
---

Your job: decide which candidates deserve to be permanently remembered.

For each candidate, choose one action:
- "promote" — worth keeping, new information
- "merge" — same as an existing memory, skip it
- "discard" — not useful enough

Respond with a JSON array. Nothing else.

[
  {
    "id": "<candidate id>",
    "action": "promote" | "merge" | "discard",
    "kind": "summary" | "decision" | "fact" | "reference" | "task" | "question",
    "title": "...",
    "summary": "...",
    "recallCue": "...",
    "status": "pending" | "active" | "done" | null
  }
]`;

// ─── Extraction ──────────────────────────────────────────────────────────────

export async function extractFromUserMessage(
  userText: string,
  sessionId: string,
  turnId: string
): Promise<CandidateMemory[]> {
  const prompt = USER_PROMPT_EXTRACT.replace("{USER_TEXT}", userText);
  const response = await llmComplete(prompt);
  return parseCandidates(response, sessionId, turnId);
}

export async function extractFromTurn(
  userText: string,
  assistantText: string,
  sessionId: string,
  turnId: string
): Promise<CandidateMemory[]> {
  const prompt = TURN_EXTRACT_PROMPT
    .replace("{USER_TEXT}", userText)
    .replace("{ASSISTANT_TEXT}", assistantText);
  const response = await llmComplete(prompt);
  return parseCandidates(response, sessionId, turnId, 3);
}

export async function reviewCandidates(
  candidates: CandidateMemory[],
  existingMemories: Memory[],
  projectName: string
): Promise<Array<CandidateMemory & { action: "promote" | "merge" | "discard" }>> {
  if (candidates.length === 0) return [];

  const prompt = COMPACT_REVIEW_PROMPT
    .replace("{PROJECT_NAME}", projectName)
    .replace("{CANDIDATES}", JSON.stringify(candidates, null, 2))
    .replace("{EXISTING}", existingMemories.length > 0
      ? JSON.stringify(existingMemories.map((m) => ({ id: m.id, kind: m.kind, title: m.title, summary: m.summary })), null, 2)
      : "(none yet)"
    );

  const response = await llmComplete(prompt);
  return parseReviewResponse(response, candidates);
}

// ─── Candidate file I/O ──────────────────────────────────────────────────────

export function writeCandidateFile(
  projectMemoryDir: string,
  candidates: CandidateMemory[]
): void {
  if (candidates.length === 0) return;
  const dir = path.join(projectMemoryDir, "candidates");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${candidates[0].turnId}.json`);
  fs.writeFileSync(file, JSON.stringify(candidates, null, 2));
}

export function readAllCandidates(projectMemoryDir: string): CandidateMemory[] {
  const dir = path.join(projectMemoryDir, "candidates");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as CandidateMemory[];
      } catch {
        return [];
      }
    });
}

export function clearCandidates(projectMemoryDir: string): void {
  const dir = path.join(projectMemoryDir, "candidates");
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .forEach((f) => fs.unlinkSync(path.join(dir, f)));
}

// ─── Session summarization ───────────────────────────────────────────────────

const SESSION_SUMMARY_PROMPT = `You are a session summarizer for an AI coding assistant.

Project: {PROJECT_NAME}

Here is the raw conversation log from this session:
---
{SESSION_LOG}
---

Generate:
1. A short title (max 60 chars) capturing the main topic or goal of this session
2. A 2-3 sentence summary of what was discussed and accomplished

Respond with JSON only. No markdown fences.
{"title": "...", "summary": "..."}`;

export async function summarizeSession(
  rawLog: string,
  projectName: string
): Promise<{ title: string; summary: string }> {
  if (!rawLog.trim()) return { title: "", summary: "" };
  const truncatedLog = rawLog.length > 8000 ? rawLog.slice(0, 8000) + "\n...[truncated]" : rawLog;
  const prompt = SESSION_SUMMARY_PROMPT
    .replace("{PROJECT_NAME}", projectName)
    .replace("{SESSION_LOG}", truncatedLog);

  const response = await llmComplete(prompt);
  try {
    const trimmed = response.trim().replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "");
    const parsed = JSON.parse(trimmed);
    return {
      title: String(parsed.title ?? "").slice(0, 60),
      summary: String(parsed.summary ?? ""),
    };
  } catch {
    return { title: "", summary: "" };
  }
}

// ─── Task completion review ───────────────────────────────────────────────────

const TASK_REVIEW_PROMPT = `You are reviewing a coding session to identify which open tasks it completed.

Session summary:
{SUMMARY}

Open tasks (JSON):
{TASKS}

Return ONLY tasks that this session clearly completed — not "maybe" or "partially".
Be conservative. If uncertain, omit.

Respond with JSON only. No markdown fences.
[{"id": "task_...", "reason": "one sentence why this session completed it"}]
Return [] if none are clearly done.`;

export async function reviewTaskCompletion(
  summary: string,
  tasks: Task[]
): Promise<{ id: string; reason: string }[]> {
  if (!summary.trim() || tasks.length === 0) return [];

  const taskList = tasks.map((t) => ({ id: t.id, title: t.title, summary: t.summary }));
  const prompt = TASK_REVIEW_PROMPT
    .replace("{SUMMARY}", summary)
    .replace("{TASKS}", JSON.stringify(taskList, null, 2));

  const response = await llmComplete(prompt);
  try {
    const trimmed = response.trim().replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "");
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    const validIds = new Set(tasks.map((t) => t.id));
    return parsed
      .filter((e) => e && typeof e.id === "string" && validIds.has(e.id) && typeof e.reason === "string")
      .map((e) => ({ id: String(e.id), reason: String(e.reason).slice(0, 200) }));
  } catch {
    return [];
  }
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

function parseCandidates(
  response: string,
  sessionId: string,
  turnId: string,
  maxItems = 2
): CandidateMemory[] {
  try {
    const trimmed = response.trim().replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "");
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, maxItems).map((c) => ({
      id: `cand_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      sessionId,
      turnId,
      createdAt: new Date().toISOString(),
      kind: c.kind ?? "fact",
      title: c.title ?? "",
      summary: c.summary ?? "",
      recallCue: c.recallCue ?? "",
      status: c.status ?? undefined,
    }));
  } catch {
    return [];
  }
}

function parseReviewResponse(
  response: string,
  candidates: CandidateMemory[]
): Array<CandidateMemory & { action: "promote" | "merge" | "discard" }> {
  try {
    const trimmed = response.trim().replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "");
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((r) => r.action === "promote")
      .map((r) => {
        const original = candidates.find((c) => c.id === r.id);
        return {
          ...(original ?? {}),
          id: r.id,
          action: r.action,
          kind: r.kind ?? original?.kind ?? "fact",
          title: r.title ?? original?.title ?? "",
          summary: r.summary ?? original?.summary ?? "",
          recallCue: r.recallCue ?? original?.recallCue ?? "",
          status: r.status ?? original?.status ?? undefined,
          sessionId: original?.sessionId ?? "",
          turnId: original?.turnId ?? "",
          createdAt: original?.createdAt ?? new Date().toISOString(),
        } as CandidateMemory & { action: "promote" };
      });
  } catch {
    return [];
  }
}
