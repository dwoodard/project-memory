plan.md

# Project Memory — Plan

## Goal

Build a lightweight, deterministic memory system that captures useful context from AI-assisted coding sessions.

The system should:

- Work automatically across all projects
- Not depend on AI tool usage (no MCP reliance)
- Stay simple, predictable, and debuggable
- Improve long-term context recall without adding noise

---

## Core Philosophy

This system is NOT:

- a full knowledge graph platform
- a complex memory engine
- a transcript storage system

This system IS:

- a small, deterministic pipeline
- that captures **only high-signal context**
- and makes it retrievable later

The core question:

> After a week in a repo, does this help me recover useful context faster?

---

## Core Concepts (v1)

Keep only three:

### Project

- Inferred from current git repo
- Scope boundary for all memory

### Session

- A working interaction sequence inside a project

### Memory

- A durable item worth keeping

---

## Memory Types (v1)

Only two:

### Note

Something worth remembering

Examples:
- "Retry bug caused by recreated jobs losing metadata"
- "DB is the source of truth for retrieval"

### Pointer

Something worth looking up later

Examples:
- "Detailed retry analysis is in retry-notes.md"
- "Original discussion happened in session X"

---

## Core Rule

A memory is saved only if:

- it is useful later without rereading the chat
- OR it helps locate something worth reopening

Otherwise → discard

---

## System Architecture

### Separation of concerns

#### Tool (global)

- Lives in: `~/projects/project-memory/`
- Contains all runtime logic

#### Per-project data

- Lives in: `<repo>/.project-memory/`
- Contains logs + memory for that repo

---

## Local Project Structure

```text
.project-memory/
  config.json
  sessions/
  memories.jsonl
  artifacts/
  sync-state.json
Purpose
sessions → completed turns
memories → extracted note/pointer entries
artifacts → saved outputs (optional)
config → project identity
sync-state → DB sync tracking
Deterministic Pipeline

Runs after every completed turn:

1. detect repo
2. resolve project
3. open/resume session
4. append turn to session log
5. extract memory (0–2 items)
6. discard or keep
7. sync kept memory to DB

No multi-stage pipelines in v1.

Input: Completed Turn

Canonical input shape:

{
  "client": "claude-code",
  "cwd": "/repo/path",
  "sessionId": "sess_001",
  "timestamp": "...",
  "messages": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ],
  "files": []
}
Tool Structure
project-memory/
  src/
    index.ts
    detect-project.ts
    append-turn.ts
    extract-memory.ts
    sync-db.ts
    types.ts
Responsibilities
index.ts
Entry point
Orchestrates full pipeline
detect-project.ts
Find repo root
Identify project
append-turn.ts
Write turn to session log
extract-memory.ts
Generate:
0 or 1 note
0 or 1 pointer
sync-db.ts
Persist memory to DB
Storage Strategy
Local (.project-memory)
noisy
operational
not used for retrieval
Central DB
clean
vetted
used for AI context
Hard Boundary

AI MUST NOT read:

session logs
local memory files
raw artifacts

AI ONLY reads:

vetted DB memory
Entry Points

System must work across:

VS Code
Claude Code
OpenAI
Ollama
LM Studio
Strategy

Adapters normalize input into:

completed turn → project-memory ingest-turn
First Adapter

Start with:

Claude Code hooks

Why:

deterministic
repo-aware
event-driven
CLI Interface

Core command:

project-memory ingest-turn --input <file>

Optional:

project-memory init
project-memory sync
Memory Format (v1)
{
  "id": "mem_001",
  "type": "note",
  "text": "...",
  "projectId": "...",
  "sessionId": "...",
  "createdAt": "...",
  "artifactPath": null
}
Embeddings (v1)

Only embed:

Memory.text

Do NOT embed:

raw logs
artifacts
local files
What We Are NOT Building (v1)
multi-stage candidate pipelines
compaction systems
memory scoring frameworks
durability levels
complex schemas
cross-project intelligence
Version 1 Success Criteria

This system is successful if:

it runs automatically
it stays simple
it produces very few, high-quality memories
it improves context recall in real usage
Next Steps
implement CLI skeleton
implement project detection
implement session logging
implement memory extraction (simple prompt)
write to .project-memory/
sync to DB
integrate Claude Code hook
test in real repo
Guiding Constraint

If something feels complex:

→ do not build it yet

Keep the loop tight.
Prove usefulness first.


---

If you want next, we should define:

**the exact `extract-memory.ts` logic (prompt + rules)**

That’s the most critical piece now.
