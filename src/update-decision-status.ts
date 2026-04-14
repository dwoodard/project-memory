/**
 * Update decision status to track implementation progress
 * Valid statuses: pending, implemented, blocked, superseded, abandoned
 */

import kuzu from "kuzu";
import { queryBuilder } from "./kuzu-helpers.js";

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

  // Try exact match first, then prefix match
  const exactMatch = await queryBuilder(conn)
    .cypher(`MATCH (m:Memory {id: $id, kind: 'decision'}) RETURN m.id`)
    .param("id", memoryId)
    .one();

  let actualId = memoryId;
  if (!exactMatch) {
    // Try prefix match
    const prefixMatch = await queryBuilder(conn)
      .cypher(`MATCH (m:Memory {kind: 'decision'})
               WHERE m.id CONTAINS $id
               RETURN m.id LIMIT 1`)
      .param("id", memoryId)
      .one();

    if (!prefixMatch) {
      throw new Error(`Decision not found: ${memoryId}`);
    }
    actualId = String(prefixMatch["m.id"]);
  }

  const now = new Date().toISOString();
  const builder = queryBuilder(conn)
    .cypher(`MATCH (m:Memory {id: $id, kind: 'decision'})
             SET m.decisionStatus = $status, m.statusUpdatedAt = $updatedAt`)
    .param("id", actualId)
    .param("status", status)
    .param("updatedAt", now);

  if (note) {
    builder.cypher(`MATCH (m:Memory {id: $id, kind: 'decision'})
                    SET m.decisionStatus = $status, m.statusUpdatedAt = $updatedAt, m.statusNote = $note`)
      .param("note", note);
  }

  await builder.count();
}

export async function getDecisionsByStatus(
  conn: InstanceType<typeof kuzu.Connection>,
  projectId: string,
  status: DecisionStatus
): Promise<Array<{ id: string; title: string; summary: string; status: DecisionStatus }>> {
  const rows = await queryBuilder(conn)
    .cypher(`MATCH (m:Memory {projectId: $projectId, kind: 'decision', decisionStatus: $status})
             RETURN m.id as id, m.title as title, m.summary as summary, m.decisionStatus as status
             ORDER BY m.createdAt DESC`)
    .param("projectId", projectId)
    .param("status", status)
    .all();

  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    summary: String(r.summary),
    status: String(r.status) as DecisionStatus,
  }));
}
