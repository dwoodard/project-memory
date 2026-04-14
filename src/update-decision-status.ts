/**
 * Update decision status to track implementation progress
 * Valid statuses: pending, implemented, blocked, superseded, abandoned
 */

import kuzu from "kuzu";
import { escape } from "./kuzu-helpers.js";

export type DecisionStatus = "pending" | "implemented" | "blocked" | "superseded" | "abandoned";

const VALID_STATUSES: DecisionStatus[] = ["pending", "implemented", "blocked", "superseded", "abandoned"];

export async function updateDecisionStatus(
  conn: InstanceType<typeof kuzu.Connection>,
  memoryId: string,
  status: DecisionStatus,
  note?: string
): Promise<void> {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}. Must be one of: ${VALID_STATUSES.join(", ")}`);
  }

  const now = new Date().toISOString();
  let query = `MATCH (m:Memory {id: '${escape(memoryId)}', kind: 'decision'})
     SET m.decisionStatus = '${escape(status)}', m.statusUpdatedAt = '${escape(now)}'`;

  if (note) {
    query += `, m.statusNote = '${escape(note)}'`;
  }

  await conn.query(query);
}

export async function getDecisionsByStatus(
  conn: InstanceType<typeof kuzu.Connection>,
  projectId: string,
  status: DecisionStatus
): Promise<Array<{ id: string; title: string; summary: string; status: DecisionStatus }>> {
  const result = await conn.query(
    `MATCH (m:Memory {projectId: '${escape(projectId)}', kind: 'decision', decisionStatus: '${escape(status)}'})
     RETURN m.id as id, m.title as title, m.summary as summary, m.decisionStatus as status
     ORDER BY m.createdAt DESC`
  );

  const rows = await (Array.isArray(result) ? result[0] : result).getAll();
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    summary: String(r.summary),
    status: String(r.status) as DecisionStatus,
  }));
}
