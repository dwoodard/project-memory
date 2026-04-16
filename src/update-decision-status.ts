/**
 * Update decision status to track implementation progress
 * Valid statuses: pending, implemented, blocked, superseded, abandoned
 */

import kuzu from "kuzu";
import { queryBuilder } from "./kuzu-helpers.js";

export type DecisionStatus = "pending" | "implemented" | "blocked" | "superseded" | "abandoned";

const VALID_STATUSES: DecisionStatus[] = ["pending", "implemented", "blocked", "superseded", "abandoned"];

interface UpdateOptions {
  note?: string;
  supersededBy?: string;
  abandonReason?: string;
}

export async function updateDecisionStatus(
  conn: InstanceType<typeof kuzu.Connection>,
  memoryId: string,
  status: DecisionStatus,
  options?: UpdateOptions | string // Support legacy string for 'note'
): Promise<void> {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}. Must be one of: ${VALID_STATUSES.join(", ")}`);
  }

  // Support legacy API: if options is a string, treat it as a note
  const opts: UpdateOptions = typeof options === "string" ? { note: options } : options || {};

  // Validate status-specific options
  if (status === "superseded" && !opts.supersededBy) {
    throw new Error("superseded status requires --superseded-by to specify the replacement decision");
  }
  if (status === "abandoned" && !opts.abandonReason) {
    throw new Error("abandoned status requires --abandoned-reason to specify why");
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

  // If superseding, validate the target decision exists
  if (opts.supersededBy) {
    const targetMatch = await queryBuilder(conn)
      .cypher(`MATCH (m:Memory {kind: 'decision'})
               WHERE m.id = $id OR m.id CONTAINS $id
               RETURN m.id LIMIT 1`)
      .param("id", opts.supersededBy)
      .one();

    if (!targetMatch) {
      throw new Error(`Target decision not found: ${opts.supersededBy}`);
    }
    opts.supersededBy = String(targetMatch["m.id"]);
  }

  const now = new Date().toISOString();
  let setClauses = "m.decisionStatus = $status, m.statusUpdatedAt = $updatedAt";

  if (opts.note) {
    setClauses += ", m.statusNote = $note";
  }
  if (opts.supersededBy) {
    setClauses += ", m.supersededBy = $supersededBy";
  }
  if (opts.abandonReason) {
    setClauses += ", m.abandonReason = $abandonReason";
  }

  const builder = queryBuilder(conn)
    .cypher(`MATCH (m:Memory {id: $id, kind: 'decision'})
             SET ${setClauses}`)
    .param("id", actualId)
    .param("status", status)
    .param("updatedAt", now);

  if (opts.note) {
    builder.param("note", opts.note);
  }
  if (opts.supersededBy) {
    builder.param("supersededBy", opts.supersededBy);
  }
  if (opts.abandonReason) {
    builder.param("abandonReason", opts.abandonReason);
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
