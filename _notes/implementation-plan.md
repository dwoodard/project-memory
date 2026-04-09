# Project Memory — Implementation Plan

## Status: In Design

---

## Goal

Build a lightweight, deterministic memory system that captures useful context from AI-assisted coding sessions.

- Works automatically across all projects
- No MCP or AI tool-call dependence for capture
- Simple, predictable, and debuggable
- Improves long-term context recall without adding noise

---

## Core Philosophy

- **Artifacts hold detail**
- **Memories hold recall cues**
- **Sessions hold provenance**

A memory is only kept if it is useful later without rereading the chat, or it helps locate something worth reopening. Otherwise it is discarded.

---

## Decisions Made

### Storage: Kuzu (per-project, embedded)

- Kuzu is an embeddable graph DB with native vector search
- No server required — files live on disk
- Sits inside `.pensieve/` in each repo
- Gives Cypher-style graph traversal + semantic vector search

### Init: Explicit CLI command

```
pensieve init
```

Runs once per repo. Sets up everything needed.

### Per-project structure

```
.pensieve/
  config.json         # project identity
  kuzu/               # Kuzu DB files
  sessions/           # raw session logs (noisy, not queried by AI)
  candidates/         # extracted but not yet promoted memories
  artifacts/          # full generated outputs
  summaries/          # rolling session summaries
  queue/              # sync queue for promotion pass
```

---

## What `pensieve init` Does

1. Detect git repo root
2. Create `.pensieve/`
3. Initialize Kuzu DB and apply schema
4. Write `config.json` with project identity
5. Create the first `Project` node in the DB
6. Add `.pensieve/` to `.gitignore`

Must be safely re-runnable (idempotent — detect existing setup and skip).

### Project identity

**Git remote URL** — stable, unique across machines, enables cross-contributor consistency.

Fallback: if no remote exists, use repo directory name + a generated UUID stored in `config.json`.

---

## Graph Schema (Kuzu)

### Node types

```
(:Project)
(:Session)
(:Memory)
(:Artifact)
```

### Relationships

```
(:Project)-[:HAS_SESSION]->(:Session)
(:Session)-[:HAS_MEMORY]->(:Memory)
(:Session)-[:PRODUCED]->(:Artifact)
(:Memory)-[:REFERS_TO]->(:Artifact)
(:Memory)-[:SUPERSEDES]->(:Memory)
(:Memory)-[:RELATED_TO]->(:Memory)
```

### Memory kinds

- `summary` — compressed recap of a session or outcome
- `decision` — a choice that was made
- `fact` — a reusable claim or believed truth
- `reference` — a pointer to something worth looking up later
- `task` — work to resume or follow up on
- `question` — an unresolved issue or uncertainty

---

## Memory Schemas

### Memory node

```json
{
  "id": "mem_001",
  "kind": "decision",
  "title": "...",
  "summary": "...",
  "recall_cue": "...",
  "projectId": "...",
  "sessionId": "...",
  "createdAt": "...",
  "artifactId": null,
  "embedding_id": "..."
}
```

### Artifact node

```json
{
  "id": "art_001",
  "type": "design_doc",
  "title": "...",
  "summary": "...",
  "location": ".pensieve/artifacts/art_001.md",
  "createdAt": "...",
  "embedding_id": "..."
}
```

---

## Pipeline: Per Turn

Runs after every completed turn:

```
1. detect repo
2. resolve project
3. open or resume session
4. append turn to session log
5. extract candidate memories (0–2)
6. score candidates against promotion heuristic
7. promote, merge, reinforce, or discard
8. update rolling session summary
```

### Three stages

```
Session Log (noisy, raw)
  -> Candidate Memory (extracted, not trusted)
    -> Promoted Memory (durable, in Kuzu)
```

---

## Memory Extraction (`extract-memory.ts`)

After each turn, send a prompt to a model with:
- The completed turn (user + assistant messages)
- The rolling session summary
- The project name

Ask it to extract 0–2 candidate memories using the promotion heuristic.

### Promotion heuristic

A memory is only promoted if at least one is true:

- it changes project understanding
- it affects future decisions
- it is likely to be needed again
- it points to an artifact worth revisiting
- it connects multiple sessions or topics
- it remains unresolved

### What NOT to promote

- routine back-and-forth
- failed attempts
- low-confidence speculation
- trivial implementation details
- raw AI output without abstraction

### Promotion checks (before writing to Kuzu)

- **Dedupe** — is this already known?
- **Merge** — is this a new version of an existing memory?
- **Reinforce** — does this strengthen an existing memory?
- **Supersede** — does this replace something outdated?
- **Promote** — is this new and worth storing?

---

## What Gets Embedded

Embed the following composed text block per Memory:

```
Kind: decision
Title: ...
Summary: ...
Recall cue: ...
Project: ...
Session: ...
```

Embed the following per Artifact:

```
Artifact type: design_doc
Title: ...
Summary: ...
```

Do NOT embed:
- raw session logs
- candidate files
- turn-level interaction data

---

## Rolling Session Summary

Each session maintains a continuously updated plain-text summary.

Updated after every turn. Used as:
- fast recall of current context
- embedding target for session-level retrieval
- input to extraction prompt

---

## Retrieval Strategy

### Two modes

**Default (automatic, invisible)**
At session start, inject a compact context bundle. Small, curated, always present. The AI has it without anyone asking.

**MCP / tools (explicit, on-demand)**
When the default context isn't enough, tools pull deeper on request — by the AI or the user.

---

### Tasks are the spine

The active task is the anchor for everything. All retrieval is filtered relative to it.

```
Active task
  -> relevant decisions
  -> open questions that may block it
  -> next tasks queued
```

---

### Session mode

The system infers mode from the active task state:

- **Planning mode** — no active task, or task kind is `question`/`decision`
  Surface: open questions, decisions made, design context, what's unresolved
- **Implementation mode** — a `task` memory is marked `active`
  Surface: current task, next task, decisions relevant to this work, blockers

---

### Task memory schema (extended)

```json
{
  "id": "mem_001",
  "kind": "task",
  "title": "Implement pensieve init",
  "summary": "...",
  "status": "active",
  "projectId": "...",
  "sessionId": "...",
  "createdAt": "...",
  "embedding_id": "..."
}
```

Task status values: `pending`, `active`, `done`, `blocked`

Only one task should be `active` per project at a time.

---

### Automatic context bundle (session start)

```
1. Active task (if any)
2. Next 2–3 pending tasks
3. Top 3–5 memories by kind priority:
     decisions first
     open questions second
     relevant facts third
4. Rolling session summary (current session)
```

Kept compact — not a full memory dump, just what's needed to orient.

---

### MCP tools

Core tools:

- `get_context` — return the current automatic bundle on demand
- `search_memories` — semantic search across all memories in this project
- `get_tasks` — return all tasks with status
- `set_active_task` — mark a task as active
- `get_artifact` — retrieve a full artifact by id or title
- `add_memory` — manually promote a memory (user-driven)

---

### Retrieval pipeline (for `search_memories`)

```
1. Filter by project
2. Vector search Memory + Artifact summaries
3. Expand via graph relationships (RELATED_TO, REFERS_TO, ABOUT)
4. Suppress superseded memories
5. Rank by: kind priority + recency + task relevance
6. Return compact result set
```

---

## CLI Interface

### Core

```
pensieve init
pensieve ingest-turn --input <file>
```

### Optional (later)

```
pensieve sync
pensieve recall
pensieve status
```

---

## First Adapter: Claude Code Hook

The first integration point is a Claude Code post-turn hook that:
1. Captures the completed turn as a JSON file
2. Calls `pensieve ingest-turn --input <file>`

Why Claude Code first:
- deterministic (hook always fires)
- repo-aware
- event-driven
- no model cooperation required

---

## Tool Structure

```
pensieve/
  src/
    index.ts            # entry point, orchestrates pipeline
    detect-project.ts   # find repo root, resolve project identity
    append-turn.ts      # write turn to session log
    extract-memory.ts   # generate candidate memories via model prompt
    promote-memory.ts   # score, dedupe, and write to Kuzu
    update-summary.ts   # update rolling session summary
    sync-db.ts          # sync promoted memories to Kuzu
    types.ts            # shared types
```

---

## What the AI Reads

**ONLY:**
- Promoted memories from Kuzu
- Artifact summaries from Kuzu
- Rolling session summary

**NEVER:**
- Raw session logs
- Candidate files
- Local `.pensieve/` files directly

---

## Next Steps

### Design (remaining)

- [ ] Define `extract-memory.ts` prompt in detail
- [ ] Define MCP server shape and tool signatures
- [ ] Define Claude Code hook payload format

### Implementation order

- [ ] Implement CLI skeleton
- [ ] Implement `pensieve init`
- [ ] Implement `detect-project.ts`
- [ ] Implement Kuzu schema + migrations
- [ ] Implement `append-turn.ts`
- [ ] Implement `extract-memory.ts`
- [ ] Implement `promote-memory.ts`
- [ ] Implement `update-summary.ts`
- [ ] Implement `assemble-context.ts` (builds automatic bundle)
- [ ] Implement MCP server with core tools
- [ ] Integrate Claude Code hook
- [ ] Test in real repo

---

## Guiding Constraint

If something feels complex → do not build it yet.

Keep the loop tight. Prove usefulness first.
