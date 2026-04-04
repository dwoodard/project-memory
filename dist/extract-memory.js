"use strict";
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
exports.buildExtractionPrompt = buildExtractionPrompt;
exports.writeCandidates = writeCandidates;
exports.parseCandidates = parseCandidates;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const EXTRACTION_PROMPT = `You are a memory extraction system for an AI-assisted coding session.

Your job: read a completed conversation turn and extract 0, 1, or 2 memories worth keeping.

## Project context
Project: {PROJECT_NAME}
Current session summary:
{SESSION_SUMMARY}

## Turn to analyze
{TURN}

## Memory kinds
- summary: compressed recap of a session or outcome
- decision: a choice that was made
- fact: a reusable claim or believed truth
- reference: a pointer to something worth looking up later
- task: work to resume or follow up on (include status: pending|active|done|blocked)
- question: an unresolved issue or uncertainty

## Promotion rules
Only extract a memory if at least one is true:
- it changes project understanding
- it affects future decisions
- it is likely to be needed again
- it points to something worth revisiting
- it remains unresolved

Do NOT extract:
- routine back-and-forth
- failed attempts
- low-confidence speculation
- trivial implementation details

## Output format
Respond with a JSON array of 0–2 memory objects. Nothing else.

[
  {
    "kind": "decision",
    "title": "Short title",
    "summary": "One or two sentence summary of what matters.",
    "recallCue": "Short phrase describing when this memory is useful",
    "status": null
  }
]

If nothing is worth keeping, respond with: []`;
function buildExtractionPrompt(turn, sessionSummary, projectName) {
    const turnText = turn.messages
        .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
        .join("\n\n");
    return EXTRACTION_PROMPT.replace("{PROJECT_NAME}", projectName)
        .replace("{SESSION_SUMMARY}", sessionSummary || "(no summary yet)")
        .replace("{TURN}", turnText);
}
function writeCandidates(candidates, projectMemoryDir, sessionId, turnId) {
    if (candidates.length === 0)
        return "";
    const candidatesDir = path.join(projectMemoryDir, "candidates");
    const file = path.join(candidatesDir, `${turnId}.json`);
    const entries = candidates.map((c) => ({
        id: `cand_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
        sessionId,
        turnId,
        createdAt: new Date().toISOString(),
        ...c,
    }));
    fs.writeFileSync(file, JSON.stringify(entries, null, 2));
    return file;
}
function parseCandidates(response) {
    try {
        const trimmed = response.trim();
        // Strip markdown code fences if present
        const json = trimmed.startsWith("```")
            ? trimmed.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "")
            : trimmed;
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed))
            return [];
        return parsed.slice(0, 2);
    }
    catch {
        return [];
    }
}
