/**
 * Shared session-start bundle logic used by both:
 *  - hook-session-start.ts  (automatic, injected before first user message)
 *  - pensieve context        (manual verification command)
 */

import { queryAll, escape } from "./kuzu-helpers.js";
import type kuzu from "kuzu";
import type { Session, Task } from "./types.js";

const BUDGET = 2000;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function shortId(id: string): string {
  return id.replace(/^(task_|mem_)/, "").slice(0, 6);
}

function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}


export function buildBundle(
  activeTask: Task | null,
  pending: Task[],
  blocked: Task[],
  recentlyDone: Task[],
  lastSession: Session | null,
  activeSubtasks: Task[] = [],
  projectDescription?: string
): string {
  const lines: string[] = [];
  let remaining = BUDGET;

  const push = (line: string) => {
    if (remaining <= 0) return;
    const safe = truncate(line, remaining);
    lines.push(safe);
    remaining -= safe.length + 1;
  };

  push(`## pensieve CLI`);
  push(`pensieve tasks              — list tasks (gantt view)`);
  push(`pensieve tasks start <n>    — set task active by queue position`);
  push(`pensieve tasks done         — complete the active task`);
  push(`pensieve tasks add "title"  — add a task to the queue`);
  push(`pensieve tasks block "why"   — mark active task blocked`);
  push(`pensieve tasks remove <n>   — delete a task by position or id`);
  push(`pensieve tasks move <f> <t> — reorder queue`);
  push(`pensieve context            — show full memory context`);
  push(`pensieve status             — show memory stats`);
  push(`pensieve search "<query>"  — pull relevant memories on demand`);
  push("");

  if (projectDescription) {
    push(`## Project`);
    push(truncate(projectDescription, 120));
    push("");
  }

  const hasTasks = activeTask !== null || pending.length > 0 || blocked.length > 0;

  if (hasTasks) {
    push(`## Tasks`);
    if (activeTask) {
      const aid = shortId(activeTask.id);
      push(`ACTIVE [${aid}]: ${activeTask.title}`);
      if (activeTask.summary) push(`  ${truncate(activeTask.summary, 120)}`);
      if (activeSubtasks.length > 0) {
        activeSubtasks.forEach((s) => {
          const checkbox = s.status === "done" ? "[x]" : s.status === "blocked" ? "[-]" : "[ ]";
          push(`  ${checkbox} [${shortId(s.id)}] ${s.title}`);
        });
      }
    }
    if (blocked.length > 0) {
      push(`Blocked:`);
      blocked.forEach((t) => {
        push(`  ✗ [${shortId(t.id)}] ${t.title}`);
        if (t.summary) push(`     ${truncate(t.summary, 80)}`);
      });
    }
    if (pending.length > 0) {
      push(`Queue:`);
      pending.forEach((t, i) => {
        push(`  ${i + 1}. [${shortId(t.id)}] ${t.title}`);
        if (t.summary) push(`     ${truncate(t.summary, 80)}`);
      });
    }
    push(`Work the active task. When done run: pensieve tasks done --note "brief summary of what you accomplished"`);
    push("");
  }

  if (recentlyDone.length > 0) {
    push(`## Recently Done`);
    recentlyDone.forEach((t) => {
      const date = t.completedAt ? ` (${formatDate(t.completedAt)})` : "";
      push(`  ✓ [${shortId(t.id)}] ${t.title}${date}`);
      if (t.completionNote) push(`      "${truncate(t.completionNote, 100)}"`);
    });
    push("");
  }

  if (lastSession) {
    const sid = lastSession.id.slice(0, 8);
    push(`## Last Session [${sid}]`);
    push("");
    push(lastSession.title || lastSession.id);
  }

  return lines.join("\n").trim();
}

export async function querySessionBundle(
  conn: InstanceType<typeof kuzu.Connection>,
  pid: string,
  excludeSessionId = ""
): Promise<string> {
  const activeRows = await queryAll(conn,
    `MATCH (t:Task {projectId: '${pid}', status: 'active'})
     RETURN t ORDER BY t.createdAt DESC LIMIT 1`);
  const pendingRows = await queryAll(conn,
    `MATCH (t:Task {projectId: '${pid}', status: 'pending'})
     WHERE t.parentId = '' OR t.parentId IS NULL
     RETURN t ORDER BY t.taskOrder ASC LIMIT 3`);
  const blockedRows = await queryAll(conn,
    `MATCH (t:Task {projectId: '${pid}', status: 'blocked'})
     WHERE t.parentId = '' OR t.parentId IS NULL
     RETURN t ORDER BY t.createdAt DESC`);
  const lastSessionRows = await queryAll(conn,
    `MATCH (s:Session {projectId: '${pid}'})
     WHERE ${excludeSessionId ? `s.id <> '${escape(excludeSessionId)}' AND ` : ""}(s.archived = false OR s.archived IS NULL)
     RETURN s ORDER BY s.startedAt DESC LIMIT 1`);
  const projectRows = await queryAll(conn,
    `MATCH (p:Project {id: '${pid}'}) RETURN p.description AS description LIMIT 1`);

  const activeTask = activeRows[0]?.["t"] as Task | undefined ?? null;
  const pending = pendingRows.map((r) => r["t"] as Task);
  const blocked = blockedRows.map((r) => r["t"] as Task);
  const lastSession = lastSessionRows[0]?.["s"] as Session | undefined ?? null;
  const projectDescription = String(projectRows[0]?.["description"] ?? "").trim() || undefined;

  // Recently done: everything completed since the last session started (captures a full work session)
  // Fall back to last 5 if no session reference point
  const sinceTs = lastSession?.startedAt ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const doneRows = await queryAll(conn,
    `MATCH (t:Task {projectId: '${pid}', status: 'done'})
     WHERE (t.parentId = '' OR t.parentId IS NULL)
     AND t.completedAt >= '${escape(sinceTs)}'
     RETURN t ORDER BY t.completedAt DESC`);
  const recentlyDone = doneRows.map((r) => r["t"] as Task);

  let activeSubtasks: Task[] = [];
  if (activeTask) {
    const subtaskRows = await queryAll(conn,
      `MATCH (t:Task {projectId: '${pid}', parentId: '${escape(activeTask.id)}'})
       WHERE t.status <> 'done'
       RETURN t ORDER BY t.taskOrder ASC`);
    activeSubtasks = subtaskRows.map((r) => r["t"] as Task);
  }

  return buildBundle(activeTask, pending, blocked, recentlyDone, lastSession, activeSubtasks, projectDescription);
}
