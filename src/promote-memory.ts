import * as crypto from "crypto";
import { queryAll, escape } from "./kuzu-helpers.js";
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

  const rows = await queryAll(
    conn,
    `MATCH (m:Memory {projectId: '${escape(projectId)}'})
     WHERE m.id <> '${escape(memory.id)}' AND size(m.embedding) > 0
     RETURN m`
  );

  for (const row of rows) {
    const candidate = row["m"] as Memory & { embedding: number[] };
    const sim = cosineSimilarity(memory.embedding, candidate.embedding);
    if (sim >= RELATED_THRESHOLD) {
      const now = new Date().toISOString();
      const score = Math.round(sim * 10000) / 10000;
      await conn.query(
        `MATCH (a:Memory {id: '${escape(memory.id)}'}), (b:Memory {id: '${escape(candidate.id)}'})
         CREATE (a)-[:RELATED_TO {score: ${score}, createdAt: '${now}', model: '${escape(embeddingModel)}'}]->(b),
                (b)-[:RELATED_TO {score: ${score}, createdAt: '${now}', model: '${escape(embeddingModel)}'}]->(a)`
      );
    }
  }
}

async function promoteTask(
  c: CandidateMemory,
  projectId: string,
  conn: InstanceType<typeof kuzu.Connection>
): Promise<Task | null> {
  // Dedupe by title across Task nodes
  const existing = await queryAll(
    conn,
    `MATCH (t:Task {projectId: '${escape(projectId)}'})
     WHERE t.title = '${escape(c.title)}'
     RETURN t.id`
  );
  if (existing.length > 0) return null;

  const status = c.status ?? "pending";

  if (status === "active") {
    // Enforce only-one-active
    await conn.query(
      `MATCH (t:Task {projectId: '${escape(projectId)}', status: 'active'})
       SET t.status = 'pending'`
    );
  }

  let taskOrder = 0;
  if (status === "pending") {
    const orderRows = await queryAll(
      conn,
      `MATCH (t:Task {projectId: '${escape(projectId)}', status: 'pending'})
       RETURN max(t.taskOrder) AS maxOrder`
    );
    taskOrder = Number(orderRows[0]?.["maxOrder"] ?? 0) + 1;
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

  await conn.query(
    `CREATE (t:Task {
      id: '${escape(task.id)}',
      title: '${escape(task.title)}',
      summary: '${escape(task.summary)}',
      status: '${escape(task.status)}',
      taskOrder: ${task.taskOrder},
      projectId: '${escape(task.projectId)}',
      createdAt: '${escape(task.createdAt)}'
    })`
  );

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
    const existing = await queryAll(
      conn,
      `MATCH (m:Memory {projectId: '${escape(projectId)}'})
       WHERE m.title = '${escape(c.title)}'
       RETURN m.id`
    );
    if (existing.length > 0) continue;

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

    const embeddingLiteral = embedding.length > 0
      ? `[${embedding.join(", ")}]`
      : `[]`;

    await conn.query(
      `CREATE (m:Memory {
        id: '${escape(memory.id)}',
        kind: '${escape(memory.kind)}',
        title: '${escape(memory.title)}',
        summary: '${escape(memory.summary)}',
        recallCue: '${escape(memory.recallCue)}',
        projectId: '${escape(memory.projectId)}',
        sessionId: '${escape(memory.sessionId)}',
        createdAt: '${escape(memory.createdAt)}',
        status: '',
        taskOrder: 0,
        embedding: ${embeddingLiteral}
      })`
    );

    // Link to session if it exists
    const sessionRows = await queryAll(conn, `MATCH (s:Session {id: '${escape(c.sessionId)}'}) RETURN s`);
    if (sessionRows.length > 0) {
      await conn.query(
        `MATCH (s:Session {id: '${escape(c.sessionId)}'}), (m:Memory {id: '${escape(memory.id)}'})
         CREATE (s)-[:HAS_MEMORY {extractedFrom: '${escape(turnId)}'}]->(m)`
      );
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
  const rows = await queryAll(
    conn,
    `MATCH (m:Memory {projectId: '${escape(projectId)}'})
     RETURN m ORDER BY m.createdAt DESC LIMIT 50`
  );
  return rows.map((r) => r["m"] as Memory);
}
