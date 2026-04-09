import type { Memory, ScoredMemory, Task, ContextBundle } from "./types.js";
import type kuzu from "kuzu";
import { queryAll, escape } from "./kuzu-helpers.js";
import { searchGraph, type ScoredNode } from "./search.js";

export async function assembleContext(
  projectId: string,
  sessionSummary: string,
  conn: InstanceType<typeof kuzu.Connection>,
  query?: string
): Promise<ContextBundle> {
  // Get active task
  const activeRows = await queryAll(
    conn,
    `MATCH (t:Task {projectId: '${escape(projectId)}', status: 'active'})
     RETURN t ORDER BY t.createdAt DESC LIMIT 1`
  );
  const activeTask: Task | null =
    activeRows.length > 0 ? (activeRows[0]["t"] as Task) : null;

  // Get next pending tasks
  const pendingRows = await queryAll(
    conn,
    `MATCH (t:Task {projectId: '${escape(projectId)}', status: 'pending'})
     RETURN t ORDER BY t.taskOrder ASC LIMIT 3`
  );
  const nextTasks: Task[] = pendingRows.map((r) => r["t"] as Task);

  // Seed query: explicit query > active task title > nothing
  const seedQuery = query ?? activeTask?.title ?? null;

  let keyMemories: ScoredMemory[];
  if (seedQuery) {
    try {
      const nodes: ScoredNode[] = await searchGraph(conn, projectId, seedQuery);
      keyMemories = nodes
        .filter((n): n is ScoredNode & { nodeType: "memory" } => n.nodeType === "memory")
        .map((n) => ({ ...(n as unknown as Memory), score: n.score, sessionTitle: n.sessionTitle, sessionSummary: n.sessionSummary }));
    } catch {
      // Fall back to recency if embedding unavailable
      keyMemories = await recencyMemories(conn, projectId);
    }
  } else {
    keyMemories = await recencyMemories(conn, projectId);
  }

  return {
    activeTask,
    nextTasks,
    keyMemories,
    sessionSummary,
  };
}

async function recencyMemories(
  conn: InstanceType<typeof kuzu.Connection>,
  projectId: string
): Promise<ScoredMemory[]> {
  const rows = await queryAll(
    conn,
    `MATCH (m:Memory {projectId: '${escape(projectId)}'})
     WHERE m.kind IN ['decision', 'question', 'fact', 'summary']
     RETURN m ORDER BY m.createdAt DESC LIMIT 8`
  );
  return rows.map((r) => ({ ...(r["m"] as Memory), score: 0 }));
}

export function formatContextBundle(bundle: ContextBundle): string {
  const isEmpty =
    !bundle.activeTask &&
    bundle.nextTasks.length === 0 &&
    bundle.keyMemories.length === 0 &&
    !bundle.sessionSummary;

  if (isEmpty) {
    return [
      "## Project Memory Context",
      "",
      "No memories yet. Memories are extracted automatically at the end of each AI turn.",
      "Run: pensieve config  to set your LLM and embedding models.",
    ].join("\n");
  }

  const lines: string[] = ["## Project Memory Context\n"];

  if (bundle.activeTask) {
    lines.push(`### Active Task\n${bundle.activeTask.title}`);
    if (bundle.activeTask.summary) lines.push(bundle.activeTask.summary);
    lines.push("");
  }

  if (bundle.nextTasks.length > 0) {
    lines.push("### Next Tasks");
    bundle.nextTasks.forEach((t) => lines.push(`- ${t.title}`));
    lines.push("");
  }

  if (bundle.keyMemories.length > 0) {
    lines.push("### Key Context");

    // Group memories by session for readability
    const bySession = new Map<string, ScoredMemory[]>();
    const noSession: ScoredMemory[] = [];

    for (const m of bundle.keyMemories) {
      if (m.sessionTitle) {
        const key = m.sessionTitle;
        if (!bySession.has(key)) bySession.set(key, []);
        bySession.get(key)!.push(m);
      } else {
        noSession.push(m);
      }
    }

    // Ungrouped first
    for (const m of noSession) {
      lines.push(`**[${m.kind}]** ${m.title}: ${m.summary}`);
      if (m.recallCue) lines.push(`  _when: ${m.recallCue}_`);
    }

    // Grouped by session
    for (const [sessionTitle, memories] of bySession) {
      lines.push(`\n_Session: ${sessionTitle}_`);
      for (const m of memories) {
        lines.push(`**[${m.kind}]** ${m.title}: ${m.summary}`);
        if (m.recallCue) lines.push(`  _when: ${m.recallCue}_`);
      }
    }

    lines.push("");
  }

  if (bundle.sessionSummary) {
    lines.push("### Last Session");
    lines.push(bundle.sessionSummary);
  }

  return lines.join("\n");
}
