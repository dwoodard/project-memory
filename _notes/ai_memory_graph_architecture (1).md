# AI Memory Graph Architecture

## Goal

Build a memory system where AI outputs are not all treated the same.

The system should help with two distinct jobs:

1. **Fast recall** — what matters right now, what was decided, what is unresolved, and what is worth revisiting.
2. **Deep lookup** — where the full details live when the compressed memory is not enough.

The core design idea is:

- **Artifacts hold detail**
- **Memories hold recall cues**
- **Sources and sessions hold provenance**

This matches how people actually work. You do not remember entire documents. You remember what a thing was about, why it mattered, and where to go when you need the full detail.

---

## Mental Model

A good starting model is:

```text
Project
  -> Session
    -> Memory
    -> Artifact
    -> Source
```

### Meaning of each layer

#### Project

A long-lived container for a body of work.

Examples:
- AI memory system
- Billing rewrite
- Internal knowledge graph

#### Session

A working unit inside a project.

Examples:
- a chat
- a planning session
- a meeting
- a research run
- an implementation pass

A session is where context is produced.

#### Memory

A compressed, reusable unit of recall.

A memory is not the full document or transcript. It is the thing worth remembering later.

Examples:
- a summary
- a decision
- a fact
- a task
- an unresolved question
- a pointer to something worth reopening

#### Artifact

A full output or detailed object.

Examples:
- a generated document
- a design spec
- a transcript
- code output
- a report
- a plan

Artifacts are what you open when memory is not enough.

#### Source

Where the information came from.

Examples:
- a user message
- an uploaded file
- a session transcript
- an external document
- a generated report

---

## Core Principle

Do **not** store every AI output as a memory.

That creates noise.

Instead:

- store detailed outputs as **Artifacts**
- store distilled, reusable recall as **Memories**
- connect the two with graph relationships

A common pattern should be:

```text
Session
  -> PRODUCED -> Artifact
Artifact
  -> DISTILLED_INTO -> Memory
Memory
  -> REFERS_TO -> Artifact
```

This gives both compression and lookup.

---

## Memory Types

Start with one `Memory` node label and a `kind` field.

Recommended initial kinds:

### 1. Summary

Compressed recap of a session, artifact, or outcome.

Examples:
- Session concluded auth should use team-scoped tokens
- This document explains the billing retry logic
- Main risk is stale cache invalidation across tenants

### 2. Decision

A choice that was made.

Examples:
- Use a hybrid graph + vector retrieval model
- Store full generated documents as artifacts, not memories
- Generate session summaries automatically

### 3. Fact

A reusable claim or believed truth.

Examples:
- Projects contain many sessions
- Each memory belongs to one session
- Artifacts may hold full generated output

### 4. Reference

A pointer saying something is worth looking up later.

Examples:
- There is a document describing billing retries
- The detailed schema draft exists in artifact X
- Look at session 14 for the original modeling discussion

This is especially important for your use case because it answers:

**What do I remember so I know what to look up?**

### 5. Task

Work to resume or follow up on.

Examples:
- Need a memory ranking strategy
- Explore whether artifacts should be versioned
- Add entity extraction before graph linking

### 6. Question

An unresolved issue or uncertainty.

Examples:
- Should memories be generated per message or per session?
- Should artifacts be versioned?
- What is the atomic unit of a memory node?

---

## Recommended Node Types

Version 1 should stay small.

```text
(:Project)
(:Session)
(:Memory)
(:Artifact)
(:Entity)
(:Topic)
(:Question)   // optional if not represented as Memory(kind=question)
```

A simpler first version can skip dedicated `Question` nodes and keep questions as `Memory(kind=question)`.

---

## Recommended Relationships

### Core structure

```text
(:Project)-[:HAS_SESSION]->(:Session)
(:Session)-[:HAS_MEMORY]->(:Memory)
(:Session)-[:PRODUCED]->(:Artifact)
(:Project)-[:HAS_ARTIFACT]->(:Artifact)
```

### Provenance and lookup

```text
(:Memory)-[:REFERS_TO]->(:Artifact)
(:Memory)-[:DERIVED_FROM]->(:Session)
(:Memory)-[:BASED_ON]->(:Artifact)
```

### Meaning and organization

```text
(:Memory)-[:ABOUT]->(:Entity)
(:Memory)-[:HAS_TOPIC]->(:Topic)
(:Artifact)-[:ABOUT]->(:Entity)
(:Artifact)-[:HAS_TOPIC]->(:Topic)
```

### Memory-to-memory structure

```text
(:Memory)-[:RELATED_TO]->(:Memory)
(:Memory)-[:SUPPORTS]->(:Memory)
(:Memory)-[:CONTRADICTS]->(:Memory)
(:Memory)-[:SUPERSEDES]->(:Memory)
(:Memory)-[:REINFORCES]->(:Memory)
```

### Summarization / derivation

```text
(:Memory)-[:SUMMARIZES]->(:Session)
(:Memory)-[:SUMMARIZES]->(:Artifact)
```

---

## Recommended Properties

### Project

```json
{
  "id": "proj_123",
  "name": "AI Memory System",
  "description": "Long-term graph and retrieval architecture for AI-produced context",
  "status": "active",
  "created_at": "2026-04-04T12:00:00Z"
}
```

### Session

```json
{
  "id": "sess_456",
  "title": "Schema planning",
  "summary": "Discussed projects, sessions, memories, artifacts, and hybrid retrieval",
  "started_at": "2026-04-04T12:00:00Z",
  "ended_at": "2026-04-04T13:00:00Z",
  "embedding_id": "..."
}
```

### Memory

```json
{
  "id": "mem_789",
  "kind": "reference",
  "title": "Detailed retrieval schema lives in artifact X",
  "summary": "The full retrieval architecture is stored as an artifact. Use it when implementing search and recall logic.",
  "recall_cue": "retrieval architecture, memory search, graph + vector",
  "lookup_reason": "Useful when implementing memory ranking or deep lookup behavior",
  "importance": 0.84,
  "confidence": 0.91,
  "status": "active",
  "created_at": "2026-04-04T12:30:00Z",
  "last_reinforced_at": "2026-04-04T12:45:00Z",
  "embedding_id": "..."
}
```

### Artifact

```json
{
  "id": "art_321",
  "type": "design_doc",
  "title": "Retrieval and memory graph draft",
  "summary": "Defines project, session, memory, artifact, and entity structure for long-term AI context storage.",
  "location": "...",
  "created_at": "2026-04-04T12:20:00Z",
  "embedding_id": "..."
}
```

### Entity

```json
{
  "id": "ent_654",
  "name": "Neo4j",
  "type": "technology"
}
```

### Topic

```json
{
  "id": "topic_987",
  "name": "memory architecture"
}
```

---

## Why Vectors Fit This Model

A hybrid **graph + vector** approach is the right fit because the graph and embeddings solve different problems.

### Graph is for

- what belongs to what
- what came from where
- what relates to what
- what supersedes what
- what artifact should be opened next
- provenance and structure

### Vectors are for

- fuzzy semantic matching
- phrasing changes
- discovering conceptually similar memories
- recovering relevant context even when links are incomplete

So the pattern should be:

- **vector search finds candidates**
- **graph traversal expands and organizes them**
- **ranking decides what actually matters**

---

## What Should Be Embedded

Do not start by embedding only raw chunks.

That helps document QA, but not memory structure.

Prioritize embeddings for compressed, recall-oriented objects:

1. `Memory.summary`
2. `Memory.recall_cue`
3. `Artifact.summary`
4. `Session.summary` (optional but useful)

Later, if needed, add raw document chunk embeddings for deep document retrieval.

### Suggested memory embedding text

Instead of embedding a single field, create a composed text block:

```text
Kind: Decision
Title: Store documents as artifacts, not memories
Summary: Full generated documents should live as artifacts. Memories should hold compressed recall-oriented cues.
Recall cue: when I need detailed generated output or implementation docs
Topics: memory architecture, retrieval, artifacts
Project: AI Memory System
Session: 2026-04-04 schema planning
```

### Suggested artifact embedding text

```text
Artifact type: design_doc
Title: Retrieval and memory graph draft
Summary: Defines project, session, memory, artifact, and entity structure for long-term AI context storage.
Useful for: graph schema, recall design, memory extraction
```

### Suggested session embedding text

```text
Session summary: Discussed using projects, sessions, and memories. Introduced reference memories and artifact-backed recall.
Key decisions: hybrid graph + vector retrieval
Open questions: ranking strategy, memory extraction rules
```

---

## Retrieval Strategy

When a new prompt comes in, the system should retrieve for both recall and lookup.

### Recommended pipeline

1. Filter by `Project`
2. Vector search `Memory`
3. Vector search `Artifact.summary`
4. Optionally vector search `Session.summary`
5. Take top candidates
6. Expand through graph relationships
7. Re-rank results
8. Return a compact context bundle

### Graph expansion should follow relationships like

- `REFERS_TO`
- `ABOUT`
- `HAS_TOPIC`
- `HAS_MEMORY`
- `PRODUCED`
- `SUPERSEDES`
- `RELATED_TO`

### Ranking should combine

- vector similarity
- memory importance
- confidence
- recency
- project relevance
- graph distance
- memory kind
- stale/superseded filtering

### Retrieval output should usually favor

- `decision`
- `reference`
- `summary`

Those are often the most useful first-pass context objects.

---

## Why This Matches Human Recall

Humans usually do not remember full documents.

They remember things like:

- there was something about X
- it matters when Y happens
- there is a document or discussion that explains it
- I should go look at that when implementing this

That means the system should optimize for generating memory objects like:

- what changed
- what mattered
- what was decided
- what remains unresolved
- what is worth reopening

This is why **reference memories** are especially important.

---

## What to Avoid Early

Avoid these in version 1:

- too many node types
- every sentence becoming a memory node
- every chunk becoming a graph node
- trying to mirror relational schemas exactly
- relying on vectors alone without provenance and relationship structure

The fastest useful version is a focused, recall-oriented graph.

---

## Strong Version 1 Recommendation

### Minimal graph shape

```text
Project
  -> HAS_SESSION -> Session
Session
  -> HAS_MEMORY -> Memory
Session
  -> PRODUCED -> Artifact
Memory
  -> REFERS_TO -> Artifact
Memory
  -> ABOUT -> Entity
Memory
  -> RELATED_TO -> Memory
Memory
  -> SUPERSEDES -> Memory
```

### Start with these memory kinds

- `summary`
- `decision`
- `fact`
- `reference`
- `question`
- `task`

### Start with these embedded objects

- Memory
- Artifact summary
- Session summary

### Add chunk retrieval later only if needed

---

## Design Heuristic for Creating a Memory

Create a memory only if at least one is true:

- it changes project understanding
- it affects future decisions
- it is likely to be needed again
- it points to an artifact worth revisiting
- it connects multiple sessions or topics
- it remains unresolved

Otherwise, keep it in the session or artifact layer.

---

## Example End-to-End Flow

```text
User prompt arrives
  -> retrieve relevant memories by vector similarity
  -> retrieve relevant artifact summaries
  -> expand neighbors in graph
  -> suppress stale/superseded items
  -> rank by importance + similarity + graph relevance
  -> provide compact recall context
  -> follow artifact links only when deeper detail is needed
```

This creates two working modes:

### Fast recall mode

What do I probably need here?

### Deep lookup mode

Open the full thing.

That split is the foundation of a durable AI memory system.

---

## Open Design Questions

These are the next major decisions to settle:

1. What is the atomic unit of a memory?
2. Should memory creation happen per message, per session, or both?
3. How should memory importance be scored?
4. When should a new memory supersede an old one?
5. Should artifacts be versioned?
6. Should entities be extracted automatically or manually curated?
7. Should unresolved questions be separate nodes or just memory kind `question`?
8. What should the context assembly budget be for a new prompt?

---

## Memory Creation Pipeline

The system should not treat every interaction as durable memory.

Instead, use a **three-layer pipeline**:

```text
Interaction Log
  -> Candidate Memory
    -> Promoted Memory
```

### 1. Interaction Log

Every prompt/response pair is stored as part of the session.

This layer is:
- noisy
- high volume
- temporary in value

It includes:
- prompts
- responses
- detected entities
- referenced files
- provisional summaries

This is useful for the **current session**, but should not directly populate the graph.

---

### 2. Candidate Memory

After each interaction, extract **candidate memories**.

These are potential memory objects that are not yet trusted.

Example:

```json
{
  "id": "cand_123",
  "kind": "decision",
  "summary": "Retry metadata should persist across recreated jobs.",
  "source_interaction_id": "int_45",
  "importance_score": 0.81,
  "novelty_score": 0.72,
  "reusability_score": 0.88,
  "confidence_score": 0.76,
  "promotion_status": "pending"
}
```

---

### 3. Promoted Memory

Only high-signal candidates become durable graph memory.

Promotion should perform these checks:

- **Dedupe** — is this already known?
- **Merge** — is this another version of an existing memory?
- **Reinforce** — does this strengthen an existing memory?
- **Supersede** — does this replace something outdated?
- **Promote** — is this worth storing long-term?

This ensures the graph grows slowly and stays high-quality.

---

## Memory Creation Strategy

The system should operate in a hybrid mode:

- capture after every interaction
- continuously evaluate candidates
- only promote high-value items

This avoids both extremes:

- storing everything (too noisy)
- storing too little (loss of continuity)

---

## What Should Become Durable Memory

Default recommendation:

- decisions
- tasks
- unresolved questions
- strong summaries
- useful references

These are the highest-signal memory types for coding workflows.

---

## What Should NOT Become Durable Memory

Avoid promoting:

- routine back-and-forth
- failed attempts
- low-confidence speculation
- trivial implementation details
- raw AI output without abstraction

---

## Scoring Dimensions for Promotion

Each candidate memory should be evaluated on:

- **importance** — does this matter?
- **reusability** — will this be needed again?
- **novelty** — is this new?
- **stability** — is this likely to remain true?
- **specificity** — is it concrete enough?
- **actionability** — does it affect future work?
- **lookup value** — does it help find something later?

The most important dimension for this system is:

**lookup value** — remembering what enables future retrieval.

---

## System Behavior After Each Interaction

For every prompt/response pair:

```text
1. Store interaction in session log
2. Extract candidate memories
3. Score candidates
4. Compare with existing project memory
5. Decide:
   - discard
   - reinforce
   - merge
   - supersede
   - promote
6. Update rolling session summary
```

---

## Rolling Session Summary

Each session should maintain a continuously updated summary.

This provides:

- fast recall of current context
- a compressed representation of the session
- a strong embedding target for retrieval

---

## Design Heuristic for Promotion

A candidate memory should be promoted only if at least one is true:

- it changes project understanding
- it affects future decisions
- it is likely to be reused
- it points to something worth revisiting
- it connects multiple sessions or topics
- it remains unresolved

---

## Why This Matters

System performance and usefulness depend on **signal quality**, not volume.

A strong promotion layer ensures:

- fewer but more meaningful nodes
- faster retrieval
- better ranking
- more accurate context reconstruction

The graph should represent **what matters**, not everything that happened.

---

## Next Phase: Deterministic Runtime Architecture

The system should **not** depend on the AI model remembering to call memory tools.

That approach is too inconsistent for a workflow where memory collection needs to always happen.

### Architectural Direction

The memory pipeline should run because of the **runtime architecture**, not because the model chose to use a tool.

This means:

- project detection is automatic
- logging is automatic
- candidate extraction is automatic
- promotion is automatic
- sync is automatic

The AI can help interpret and summarize, but it should not be responsible for deciding whether the pipeline runs.

---

## MCP Is Optional, Not Foundational

An MCP interface may still be useful, but it should not be the primary mechanism that guarantees memory collection.

Why MCP alone is not enough:

- tool use is probabilistic
- models may skip or misuse the tool
- behavior can vary across clients
- it puts orchestration pressure on the model

So the better model is:

- **runtime layer guarantees capture**
- **MCP exposes optional capabilities**
- **AI is a consumer of the system, not the orchestrator**

---

## Deterministic Runtime Layer

The system should have a runtime layer that sits between the client and the model.

Conceptually:

```text
editor / cli / app / agent
  -> project memory runtime
    -> memory pipeline
    -> model provider
    -> storage
```

This runtime becomes the guaranteed entry point for AI interactions.

---

## Deterministic Pipeline Per AI Request

For every AI request inside a repo, the runtime should always do the same sequence:

```text
1. detect current repo
2. resolve project
3. open or resume session
4. retrieve project-scoped context
5. construct prompt package
6. call model
7. store request/response locally
8. generate candidate memories
9. run scoring and promotion pass
10. sync durable memory to central DB
11. update rolling session summary
```

This happens because the runtime owns the pipeline, not because the model remembered a tool call.

---

## Repo as Context Boundary

The current git repository / working directory defines the active project.

That means:

```text
working directory
  -> repo detected
  -> project resolved
  -> session attached to project
```

Everything defaults to this project scope unless cross-project access is explicitly requested.

---

## Local Project Workspace

A hidden directory in the repo is a strong fit for local runtime state.

Recommended shape:

```text
your-repo/
  .pensieve/
```

This directory should be the **local runtime workspace**, not the long-term database.

Its purpose is to hold:

- local config
- session state
- noisy interaction logs
- candidate memory files
- generated artifacts
- summaries
- cache
- sync queue

Example structure:

```text
.pensieve/
  config.json
  sessions/
  interactions/
  candidates/
  artifacts/
  summaries/
  queue/
  cache/
```

---

## Central Durable Store

The long-term system should still use a central durable store outside the repo.

This is the recommended source of truth for:

- all projects
- durable graph memory
- embeddings
- cross-session retrieval
- cross-project opt-in search
- provenance and ranking

Recommended split:

- **central DB = source of truth**
- **repo-local directory = runtime workspace, cache, journal, and inspectable pipeline state**

This gives both strong global retrieval and clear local visibility.

---

## Day-One Project Lifecycle

The first time AI is used inside a repo, the runtime should:

1. detect repo root
2. resolve repo name, remote, and branch
3. create or match a `Project`
4. create `.pensieve/`
5. initialize project config
6. create the first `Session`
7. start logging interactions locally
8. begin project-scoped retrieval
9. start candidate extraction and promotion

This allows the system to start collecting useful memory from the first interaction.

---

## Normal Day-to-Day Flow

In daily coding work, the system should feel invisible but consistent.

```text
open repo
  -> AI session starts
  -> project inferred
  -> project-scoped context retrieved
  -> interaction happens
  -> interaction logged locally
  -> candidate memories extracted
  -> promotion filters signal from noise
  -> durable memory updated centrally
```

The key benefit is that project memory keeps building without requiring manual setup or manual tool invocation.

---

## Cross-Project Behavior

Cross-project retrieval should remain opt-in.

Examples:

- "Have I solved this in another repo before?"
- "Search all projects for auth-related decisions"
- "Show similar memory from other projects"

This keeps the default experience relevant and avoids contamination from unrelated codebases.

---

## What the Runtime Owns

The runtime should be responsible for:

- detecting the active project
- managing `.pensieve/`
- opening and updating sessions
- retrieving context
- recording interactions
- extracting candidates
- promoting memory
- storing artifacts
- syncing durable state to the central DB

The AI can still help with:

- summaries
- candidate memory generation
- memory classification
- entity extraction
- topic extraction
- session summary drafting

But the runtime should control when and how those steps happen.

---

## Role of MCP in This Architecture

MCP can still be useful as an adapter or interface layer.

It can expose capabilities like:

- get current project context
- search memories
- inspect artifacts
- promote an explicit note
- run cross-project search

But it should sit **on top of** the deterministic runtime, not replace it.

That means:

- **runtime-first**
- **MCP optional**
- **AI-assisted extraction**
- **not AI-orchestrated capture**

---

## Recommended Runtime Shape

The most promising direction is a local runtime service with thin adapters.

That suggests:

- one local deterministic core
- editor adapter
- CLI adapter
- agent/app adapter
- optional MCP adapter

This gives you a single reliable implementation with multiple entry points.

---

## Design Goal

The system should behave like:

- a **project-scoped memory runtime**
- with **automatic capture and filtering**
- backed by a **central durable graph/vector store**
- with **optional MCP access**, but not MCP dependence

---

## Next Exploration Areas

The next major areas to define are:

1. **Runtime entry points** — how editor, CLI, and agents route through the system
2. **Local workspace format** — what exactly lives in `.pensieve/`
3. **Sync strategy** — when local state becomes durable central memory
4. **Memory ranking strategy** — how retrieval prioritizes memories and artifacts
5. **Cross-project promotion** — how local project knowledge becomes globally reusable

These decisions determine how reliable and invisible the system feels in daily use.

