import type { Memory, ContextBundle } from "./types.js";
import type kuzu from "kuzu";
import { queryAll } from "./kuzu-helpers.js";

function escape(s: string): string {
  return (s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function assembleContext(
  projectId: string,
  sessionSummary: string,
  conn: InstanceType<typeof kuzu.Connection>
): Promise<ContextBundle> {
  // Get active task
  const activeRows = await queryAll(
    conn,
    `MATCH (m:Memory {projectId: '${escape(projectId)}', kind: 'task', status: 'active'})
     RETURN m ORDER BY m.createdAt DESC LIMIT 1`
  );
  const activeTask: Memory | null =
    activeRows.length > 0 ? (activeRows[0]["m"] as Memory) : null;

  // Get next pending tasks
  const pendingRows = await queryAll(
    conn,
    `MATCH (m:Memory {projectId: '${escape(projectId)}', kind: 'task', status: 'pending'})
     RETURN m ORDER BY m.createdAt ASC LIMIT 3`
  );
  const nextTasks: Memory[] = pendingRows.map((r) => r["m"] as Memory);

  // Get key memories — decisions first, then questions, then facts
  const memoriesRows = await queryAll(
    conn,
    `MATCH (m:Memory {projectId: '${escape(projectId)}'})
     WHERE m.kind IN ['decision', 'question', 'fact', 'summary']
     RETURN m ORDER BY m.createdAt DESC LIMIT 5`
  );
  const keyMemories: Memory[] = memoriesRows.map((r) => r["m"] as Memory);

  return {
    activeTask,
    nextTasks,
    keyMemories,
    sessionSummary,
  };
}

export function formatContextBundle(bundle: ContextBundle): string {
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
    bundle.keyMemories.forEach((m) => {
      lines.push(`**[${m.kind}]** ${m.title}: ${m.summary}`);
    });
    lines.push("");
  }

  if (bundle.sessionSummary) {
    lines.push("### Session Summary");
    lines.push(bundle.sessionSummary);
  }

  return lines.join("\n");
}
