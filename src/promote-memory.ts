import * as crypto from "crypto";
import { queryBuilder } from "./kuzu-helpers.js";
import { embed } from "./llm.js";
import { cosineSimilarity } from "./search.js";
import type { Memory, Task } from "./types.js";
import type { CandidateMemory } from "./extract-memory.js";
import type kuzu from "kuzu";

const RELATED_THRESHOLD = 0.82; // minimum cosine similarity to create a RELATED_TO edge

async function linkRelatedMemories(
  memory: Memory & { embedding: number[] },
  projectId: string,
  conn: InstanceType<typeof kuzu.Connection>,
  embeddingModel = ""
): Promise<void> {
  if (memory.embedding.length === 0) return;

  const rows = await queryBuilder(conn)
    .cypher(`MATCH (m:Memory {projectId: $projectId})
             WHERE m.id <> $memoryId AND size(m.embedding) > 0
             RETURN m`)
    .param("projectId", projectId)
    .param("memoryId", memory.id)
    .all();

  for (const row of rows) {
    const candidate = row["m"] as Memory & { embedding: number[] };
    const sim = cosineSimilarity(memory.embedding, candidate.embedding);
    if (sim >= RELATED_THRESHOLD) {
      const now = new Date().toISOString();
      const score = Math.round(sim * 10000) / 10000;
      await queryBuilder(conn)
        .cypher(`MATCH (a:Memory {id: $aId}), (b:Memory {id: $bId})
                 CREATE (a)-[:RELATED_TO {score: $score, createdAt: $createdAt, model: $model}]->(b),
                        (b)-[:RELATED_TO {score: $score, createdAt: $createdAt, model: $model}]->(a)`)
        .param("aId", memory.id)
        .param("bId", candidate.id)
        .param("score", score)
        .param("createdAt", now)
        .param("model", embeddingModel)
        .count();
    }
  }
}

async function promoteTask(
  c: CandidateMemory,
  projectId: string,
  conn: InstanceType<typeof kuzu.Connection>
): Promise<Task | null> {
  // Dedupe by title across Task nodes
  const existing = await queryBuilder(conn)
    .cypher(`MATCH (t:Task {projectId: $projectId})
             WHERE t.title = $title
             RETURN t.id`)
    .param("projectId", projectId)
    .param("title", c.title)
    .one();

  if (existing) return null;

  const status = c.status ?? "pending";

  if (status === "active") {
    // Enforce only-one-active
    await queryBuilder(conn)
      .cypher(`MATCH (t:Task {projectId: $projectId, status: 'active'})
               SET t.status = 'pending'`)
      .param("projectId", projectId)
      .count();
  }

  let taskOrder = 0;
  if (status === "pending") {
    const orderResult = await queryBuilder(conn)
      .cypher(`MATCH (t:Task {projectId: $projectId, status: 'pending'})
               RETURN max(t.taskOrder) AS maxOrder`)
      .param("projectId", projectId)
      .one();

    taskOrder = Number(orderResult?.["maxOrder"] ?? 0) + 1;
  }

  const task: Task = {
    id: `task_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    title: c.title,
    summary: c.summary,
    status,
    taskOrder,
    projectId,
    createdAt: new Date().toISOString(),
  };

  await queryBuilder(conn)
    .cypher(`CREATE (t:Task {
      id: $id,
      title: $title,
      summary: $summary,
      status: $status,
      taskOrder: $taskOrder,
      projectId: $projectId,
      createdAt: $createdAt
    })`)
    .param("id", task.id)
    .param("title", task.title)
    .param("summary", task.summary)
    .param("status", task.status)
    .param("taskOrder", task.taskOrder)
    .param("projectId", task.projectId)
    .param("createdAt", task.createdAt)
    .count();

  return task;
}

export async function promoteToDb(
  candidates: CandidateMemory[],
  projectId: string,
  conn: InstanceType<typeof kuzu.Connection>,
  opts: { turnId?: string; embeddingModel?: string } = {}
): Promise<Memory[]> {
  const { turnId = "", embeddingModel = "" } = opts;
  const promoted: Memory[] = [];

  for (const c of candidates) {
    if (c.kind === "task") {
      await promoteTask(c, projectId, conn);
      continue;
    }

    // Dedupe by title
    const existing = await queryBuilder(conn)
      .cypher(`MATCH (m:Memory {projectId: $projectId})
               WHERE m.title = $title
               RETURN m.id`)
      .param("projectId", projectId)
      .param("title", c.title)
      .one();

    if (existing) continue;

    let embedding: number[] = [];
    try {
      embedding = await embed(`${c.title}. ${c.summary}`);
    } catch {
      // Embedding is best-effort — don't block promotion if model is unavailable
    }

    const memory: Memory = {
      id: `mem_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      kind: c.kind,
      title: c.title,
      summary: c.summary,
      recallCue: c.recallCue,
      projectId,
      sessionId: c.sessionId,
      createdAt: new Date().toISOString(),
      embedding,
    };

    await queryBuilder(conn)
      .cypher(`CREATE (m:Memory {
        id: $id,
        kind: $kind,
        title: $title,
        summary: $summary,
        recallCue: $recallCue,
        projectId: $projectId,
        sessionId: $sessionId,
        createdAt: $createdAt,
        status: '',
        taskOrder: 0,
        embedding: $embedding
      })`)
      .param("id", memory.id)
      .param("kind", memory.kind)
      .param("title", memory.title)
      .param("summary", memory.summary)
      .param("recallCue", memory.recallCue)
      .param("projectId", memory.projectId)
      .param("sessionId", memory.sessionId)
      .param("createdAt", memory.createdAt)
      .param("embedding", memory.embedding)
      .count();

    // Link to session if it exists
    const sessionExists = await queryBuilder(conn)
      .cypher(`MATCH (s:Session {id: $sessionId}) RETURN s`)
      .param("sessionId", c.sessionId)
      .one();

    if (sessionExists) {
      await queryBuilder(conn)
        .cypher(`MATCH (s:Session {id: $sessionId}), (m:Memory {id: $memoryId})
                 CREATE (s)-[:HAS_MEMORY {extractedFrom: $turnId}]->(m)`)
        .param("sessionId", c.sessionId)
        .param("memoryId", memory.id)
        .param("turnId", turnId)
        .count();
    }

    // Wire RELATED_TO edges to similar existing memories
    if (embedding.length > 0) {
      try {
        await linkRelatedMemories({ ...memory, embedding }, projectId, conn, embeddingModel);
      } catch {
        // Never block promotion on graph wiring failures
      }
    }

    promoted.push(memory);
  }

  return promoted;
}

export async function getExistingMemories(
  projectId: string,
  conn: InstanceType<typeof kuzu.Connection>
): Promise<Memory[]> {
  const rows = await queryBuilder(conn)
    .cypher(`MATCH (m:Memory {projectId: $projectId})
             RETURN m ORDER BY m.createdAt DESC LIMIT 50`)
    .param("projectId", projectId)
    .all();

  return rows.map((r) => r["m"] as Memory);
}
