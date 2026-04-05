"use strict";
/**
 * LLM-based memory extraction.
 * Used by both UserPromptSubmit (user text only) and PreCompact (full candidates review).
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractFromUserMessage = extractFromUserMessage;
exports.extractFromTurn = extractFromTurn;
exports.reviewCandidates = reviewCandidates;
exports.writeCandidateFile = writeCandidateFile;
exports.readAllCandidates = readAllCandidates;
exports.clearCandidates = clearCandidates;
exports.summarizeSession = summarizeSession;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const llm_js_1 = require("./llm.js");
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
async function extractFromUserMessage(userText, sessionId, turnId) {
    const prompt = USER_PROMPT_EXTRACT.replace("{USER_TEXT}", userText);
    const response = await (0, llm_js_1.llmComplete)(prompt);
    return parseCandidates(response, sessionId, turnId);
}
async function extractFromTurn(userText, assistantText, sessionId, turnId) {
    const prompt = TURN_EXTRACT_PROMPT
        .replace("{USER_TEXT}", userText)
        .replace("{ASSISTANT_TEXT}", assistantText);
    const response = await (0, llm_js_1.llmComplete)(prompt);
    return parseCandidates(response, sessionId, turnId, 3);
}
async function reviewCandidates(candidates, existingMemories, projectName) {
    if (candidates.length === 0)
        return [];
    const prompt = COMPACT_REVIEW_PROMPT
        .replace("{PROJECT_NAME}", projectName)
        .replace("{CANDIDATES}", JSON.stringify(candidates, null, 2))
        .replace("{EXISTING}", existingMemories.length > 0
        ? JSON.stringify(existingMemories.map((m) => ({ id: m.id, kind: m.kind, title: m.title, summary: m.summary })), null, 2)
        : "(none yet)");
    const response = await (0, llm_js_1.llmComplete)(prompt);
    return parseReviewResponse(response, candidates);
}
// ─── Candidate file I/O ──────────────────────────────────────────────────────
function writeCandidateFile(projectMemoryDir, candidates) {
    if (candidates.length === 0)
        return;
    const dir = path.join(projectMemoryDir, "candidates");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${candidates[0].turnId}.json`);
    fs.writeFileSync(file, JSON.stringify(candidates, null, 2));
}
function readAllCandidates(projectMemoryDir) {
    const dir = path.join(projectMemoryDir, "candidates");
    if (!fs.existsSync(dir))
        return [];
    return fs.readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .flatMap((f) => {
        try {
            return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
        }
        catch {
            return [];
        }
    });
}
function clearCandidates(projectMemoryDir) {
    const dir = path.join(projectMemoryDir, "candidates");
    if (!fs.existsSync(dir))
        return;
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
async function summarizeSession(rawLog, projectName) {
    if (!rawLog.trim())
        return { title: "", summary: "" };
    const truncatedLog = rawLog.length > 4000 ? rawLog.slice(0, 4000) + "\n...[truncated]" : rawLog;
    const prompt = SESSION_SUMMARY_PROMPT
        .replace("{PROJECT_NAME}", projectName)
        .replace("{SESSION_LOG}", truncatedLog);
    const response = await (0, llm_js_1.llmComplete)(prompt);
    try {
        const trimmed = response.trim().replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "");
        const parsed = JSON.parse(trimmed);
        return {
            title: String(parsed.title ?? "").slice(0, 60),
            summary: String(parsed.summary ?? ""),
        };
    }
    catch {
        return { title: "", summary: "" };
    }
}
// ─── Parsing ─────────────────────────────────────────────────────────────────
function parseCandidates(response, sessionId, turnId, maxItems = 2) {
    try {
        const trimmed = response.trim().replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "");
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed))
            return [];
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
    }
    catch {
        return [];
    }
}
function parseReviewResponse(response, candidates) {
    try {
        const trimmed = response.trim().replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "");
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed))
            return [];
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
            };
        });
    }
    catch {
        return [];
    }
}
