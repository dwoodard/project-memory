import * as crypto from "crypto";
import type {
  CandidateMemory,
  Memory,
  ProjectConfig,
} from "./types.js";
import type kuzu from "kuzu";
import { queryAll } from "./kuzu-helpers.js";

function escape(s: string): string {
  return (s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function promoteMemories(
  candidates: CandidateMemory[],
  sessionId: string,
  config: ProjectConfig,
  conn: InstanceType<typeof kuzu.Connection>
): Promise<Memory[]> {
  const promoted: Memory[] = [];

  for (const candidate of candidates) {
    // Dedupe: check if a memory with the same title already exists
    const rows = await queryAll(
      conn,
      `MATCH (m:Memory {projectId: '${escape(config.projectId)}'})
       WHERE m.title = '${escape(candidate.title)}'
       RETURN m.id`
    );
    if (rows.length > 0) continue; // already known

    const memory: Memory = {
      id: `mem_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      kind: candidate.kind,
      title: candidate.title,
      summary: candidate.summary,
      recallCue: candidate.recallCue,
      projectId: config.projectId,
      sessionId,
      createdAt: new Date().toISOString(),
      status: candidate.status ?? undefined,
      artifactId: undefined,
    };

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
        status: '${escape(memory.status ?? "")}',
        artifactId: '${escape(memory.artifactId ?? "")}'
      })`
    );

    // Link memory to session
    await conn.query(
      `MATCH (s:Session {id: '${escape(sessionId)}'}), (m:Memory {id: '${escape(memory.id)}'})
       CREATE (s)-[:HAS_MEMORY]->(m)`
    );

    promoted.push(memory);
  }

  return promoted;
}
