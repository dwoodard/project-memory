# 🧙‍♂️ Pensieve

> **"I use the Pensieve. One simply siphons the excess thoughts from one's mind, pours them into the basin, and examines them at one's leisure. It becomes easier to spot patterns and links, you understand, when they are in this form."**
> — *Albus Dumbledore*
>
> A Pensieve was a very rare and powerful magical item used to store and review memories. It had the appearance of a shallow stone basin filled with a silvery substance — a cloudy liquid/gas of collected recollections. Pensieves were rare because only the most advanced wizards ever used them, and because the majority of wizardkind is afraid of doing so.
> — [Harry Potter Wiki](https://harrypotter.fandom.com/wiki/Pensieve)

---

## The Idea

Think of **Pensieve** as the real-world counterpart to Dumbledore's memory basin.

Instead of a silver, cloud-filled bowl, we have a tiny, local graph database that silently collects the thoughts — decisions, tasks, facts, open questions — you and Claude generate while coding. When you open a new session, Pensieve spills the relevant memories into Claude's system prompt so you can pick up exactly where you left off, without re-explaining anything.

---

## How it Works

Pensieve hooks directly into Claude Code's lifecycle events, running silently in the background and storing memory nodes into a local [Kuzu](https://kuzudb.com/) graph database inside your repo.

```
Session starts  →  Pensieve injects a context bundle into Claude's system prompt
User sends message  →  LLM extracts tasks/decisions/facts on the fly
Session ends  →  full turn summarized, memories promoted to graph
Context compacts  →  candidates reviewed and consolidated before they vanish
```

Every session builds on the last. Claude walks in already knowing your active task, recent decisions, and open questions — without you saying a word.

---

## Features

| Feature | What it does |
| ------- | ------------ |
| **Automatic memory extraction** | The LLM reads each turn and pulls out decisions, tasks, facts, and open questions. |
| **Graph-backed storage** | Kuzu stores memories with relationships to projects, sessions, and artifacts. |
| **Semantic search** | Cosine similarity over embeddings lets you query memories by meaning, not keyword. |
| **Session continuity** | Each new session opens with a context bundle: active task, queue, and last-session summary. |
| **Task management** | Built-in task queue with `pending → active → done` lifecycle, surfaced every session. |
| **Context compaction** | Pre-Compact hook reviews candidate memories before Claude's context window resets. |
| **Zero config after init** | Hooks wire themselves into `.claude/settings.json` automatically. |

---

## Installation

```bash
npm install -g pensieve
```

Then initialize in any git repo:

```bash
cd your-project
pensieve init
```

This creates a hidden `.pensieve/` directory (added to `.gitignore`) and writes Claude Code hook entries into `.claude/settings.json`.

Configure your LLM and embedding providers:

```bash
pensieve config
```

---

## Usage

Once initialized, everything runs automatically through Claude Code hooks. The CLI lets you inspect and manage what's been captured.

### Task management

```bash
pensieve tasks                  # view task queue (Gantt view)
pensieve tasks add "title"      # add a task
pensieve tasks start <n>        # set task active by queue position
pensieve tasks done             # complete the active task
pensieve tasks block "reason"   # mark active task blocked
pensieve tasks remove <n>       # delete by position or id
pensieve tasks move <from> <to> # reorder the queue
```

### Memory inspection

```bash
pensieve context                # show current context bundle
pensieve status                 # memory stats (counts by kind, sessions, last activity)
pensieve search "query"         # semantic search across all memories
pensieve search "query" -k 10   # return top 10 results
```

### Maintenance

```bash
pensieve backfill-embeddings    # generate embeddings for any memory nodes missing them
```

---

## Context bundle

At the start of every Claude Code session, Pensieve injects a bundle into Claude's system prompt:

```
## Tasks
ACTIVE: Wire up semantic search to context assembly
Queue:
  1. Add PostToolUse hook for artifact detection
  2. Write README

## Last Session
Refactored memory extraction to use candidate staging
```

Claude sees your task queue and last-session summary before you type a single word.

---

## Memory kinds

| Kind | What it captures |
|------|-----------------|
| `decision` | architectural choices, approach selections |
| `task` | next steps, TODOs, follow-ups |
| `fact` | project-specific truths, constraints, config details |
| `question` | open questions, unresolved blockers |
| `reference` | pointers to external systems, docs, dashboards |
| `summary` | session-level summaries |

---

## Graph schema

```
Project
  └─HAS_SESSION→ Session
       └─HAS_MEMORY→ Memory
       └─HAS_ARTIFACT→ Artifact
Task (linked to Project)
```

Memories carry vector embeddings for semantic search. Relationships let you trace any memory back to the session that produced it and see what else was captured alongside it.

---

## Requirements

- Node.js 18+
- Claude Code CLI
- An LLM API key (Anthropic, OpenAI, or compatible) for extraction and embeddings

---

## Why not just use Claude's memory feature?

Claude's built-in memory is global and unstructured. Pensieve is:

- **Per-repo** — memories are scoped to your project, not your account
- **Structured** — typed nodes with relationships you can query
- **Searchable** — semantic search over embeddings, not keyword matching
- **Task-aware** — first-class task queue surfaced every session
- **Private** — stored locally in your repo, never leaves your machine

---

## 🎩 Final thought

With Pensieve you can finally "siphon the excess thoughts from your mind" and let Claude help you sift through them — just like Dumbledore did with his silver basin. Happy memory-keeping.

---

## License

ISC
