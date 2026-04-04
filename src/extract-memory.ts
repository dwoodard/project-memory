import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { Turn, CandidateMemory } from "./types.js";

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

export function buildExtractionPrompt(
  turn: Turn,
  sessionSummary: string,
  projectName: string
): string {
  const turnText = turn.messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");

  return EXTRACTION_PROMPT.replace("{PROJECT_NAME}", projectName)
    .replace("{SESSION_SUMMARY}", sessionSummary || "(no summary yet)")
    .replace("{TURN}", turnText);
}

export function writeCandidates(
  candidates: CandidateMemory[],
  projectMemoryDir: string,
  sessionId: string,
  turnId: string
): string {
  if (candidates.length === 0) return "";

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

export function parseCandidates(response: string): CandidateMemory[] {
  try {
    const trimmed = response.trim();
    // Strip markdown code fences if present
    const json = trimmed.startsWith("```")
      ? trimmed.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "")
      : trimmed;
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 2);
  } catch {
    return [];
  }
}
