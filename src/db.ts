import kuzu from "kuzu";
import * as fs from "fs";
import * as path from "path";
import { cosineSimilarity } from "./search.js";
import { embed } from "./llm.js";
import { escape } from "./kuzu-helpers.js";

const _cache = new Map<string, {
  db: InstanceType<typeof kuzu.Database>;
  conn: InstanceType<typeof kuzu.Connection>;
}>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getDb(projectMemoryDir: string): Promise<{
  db: InstanceType<typeof kuzu.Database>;
  conn: InstanceType<typeof kuzu.Connection>;
}> {
  const cached = _cache.get(projectMemoryDir);
  if (cached) return cached;

  // Explorer expects KUZU_DIR/database.kz — create the parent dir and use that filename
  const graphDir = path.join(projectMemoryDir, "graph");
  fs.mkdirSync(graphDir, { recursive: true });
  const dbPath = path.join(graphDir, "database.kz");

  // Retry when another process holds the lock (e.g. a hook still running)
  const maxAttempts = 15;
  const delayMs = 300;
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const db = new kuzu.Database(dbPath);
      const conn = new kuzu.Connection(db);
      _cache.set(projectMemoryDir, { db, conn });
      return { db, conn };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("Could not set lock")) throw err;
      lastErr = err;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

export async function applySchema(
  conn: InstanceType<typeof kuzu.Connection>,
  projectMemoryDir?: string
): Promise<void> {
  const statements = [
    `CREATE NODE TABLE IF NOT EXISTS Project(
      id STRING,
      name STRING,
      remoteUrl STRING,
      repoPath STRING,
      createdAt STRING,
      description STRING,
      PRIMARY KEY (id)
    )`,
    `CREATE NODE TABLE IF NOT EXISTS Session(
      id STRING,
      projectId STRING,
      startedAt STRING,
      title STRING,
      summary STRING,
      embedding FLOAT[],
      PRIMARY KEY (id)
    )`,
    `CREATE NODE TABLE IF NOT EXISTS Memory(
      id STRING,
      kind STRING,
      title STRING,
      summary STRING,
      recallCue STRING,
      projectId STRING,
      sessionId STRING,
      createdAt STRING,
      status STRING,
      taskOrder INT64,
      embedding FLOAT[],
      PRIMARY KEY (id)
    )`,
    `CREATE NODE TABLE IF NOT EXISTS Task(
      id STRING,
      title STRING,
      summary STRING,
      status STRING,
      taskOrder INT64,
      projectId STRING,
      createdAt STRING,
      embedding FLOAT[],
      PRIMARY KEY (id)
    )`,
    `CREATE NODE TABLE IF NOT EXISTS Turn(
      id STRING,
      sessionId STRING,
      projectId STRING,
      timestamp STRING,
      userText STRING,
      assistantText STRING,
      summary STRING,
      embedding FLOAT[],
      PRIMARY KEY (id)
    )`,
    `CREATE NODE TABLE IF NOT EXISTS File(
      id STRING,
      path STRING,
      projectId STRING,
      language STRING,
      lastSeenAt STRING,
      PRIMARY KEY (id)
    )`,
    `CREATE REL TABLE IF NOT EXISTS HAS_SESSION(FROM Project TO Session)`,
    `CREATE REL TABLE IF NOT EXISTS HAS_TASK(FROM Project TO Task)`,
    `CREATE REL TABLE IF NOT EXISTS HAS_MEMORY(FROM Session TO Memory)`,
    `CREATE REL TABLE IF NOT EXISTS HAS_TURN(FROM Session TO Turn)`,
    `CREATE REL TABLE IF NOT EXISTS REFERENCES(FROM Turn TO File)`,
    `CREATE REL TABLE IF NOT EXISTS RELATED_TO(FROM Memory TO Memory, score FLOAT, createdAt STRING, model STRING)`,
    `CREATE REL TABLE IF NOT EXISTS LINKED(FROM Memory TO Memory, relation STRING, createdAt STRING, note STRING, source STRING, confidence FLOAT, sessionId STRING)`,
    `CREATE REL TABLE IF NOT EXISTS WORKED_ON(FROM Session TO Task, createdAt STRING)`,
    `CREATE REL TABLE IF NOT EXISTS MENTIONS(FROM Task TO Memory, context STRING, createdAt STRING)`,
  ];

  for (const stmt of statements) {
    await conn.query(stmt);
  }

  // Migration: move task Memory nodes → Task nodes
  try {
    const taskMemories = await conn.query(
      `MATCH (m:Memory {kind: 'task'}) RETURN m`
    );
    const qr = Array.isArray(taskMemories) ? taskMemories[0] : taskMemories;
    const rows = await (qr as { getAll(): Promise<Record<string, unknown>[]> }).getAll();

    for (const row of rows) {
      const m = row["m"] as Record<string, unknown>;
      const id = String(m["id"]);
      const esc = (s: string) => (s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");

      // Check if already migrated
      const existing = await conn.query(`MATCH (t:Task {id: '${esc(id)}'}) RETURN t.id`);
      const eqr = Array.isArray(existing) ? existing[0] : existing;
      const erows = await (eqr as { getAll(): Promise<Record<string, unknown>[]> }).getAll();
      if (erows.length > 0) continue;

      const status = String(m["status"] || "pending");
      const taskOrder = Number(m["taskOrder"] ?? 0);
      const projectId = String(m["projectId"] ?? "");
      await conn.query(
        `CREATE (t:Task {
          id: '${esc(id)}',
          title: '${esc(String(m["title"] ?? ""))}',
          summary: '${esc(String(m["summary"] ?? ""))}',
          status: '${esc(status)}',
          taskOrder: ${taskOrder},
          projectId: '${esc(projectId)}',
          createdAt: '${esc(String(m["createdAt"] ?? new Date().toISOString()))}'
        })`
      );
      await conn.query(
        `MATCH (p:Project {id: '${esc(projectId)}'}), (t:Task {id: '${esc(id)}'})
         CREATE (p)-[:HAS_TASK]->(t)`
      );
    }

    // Remove migrated task Memory nodes
    if (rows.length > 0) {
      await conn.query(`MATCH (m:Memory {kind: 'task'}) DETACH DELETE m`);
    }
  } catch {
    // Migration already done or no task memories exist
  }

  // Column migrations — safe to ignore if already applied
  try { await conn.query(`ALTER TABLE Project ADD description STRING DEFAULT ''`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Task ADD parentId STRING DEFAULT ''`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Task ADD completedAt STRING DEFAULT ''`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Task ADD completionNote STRING DEFAULT ''`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Memory ADD taskOrder INT64 DEFAULT 0`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Session ADD title STRING DEFAULT ''`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Session ADD archived BOOLEAN DEFAULT false`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Memory ADD embedding FLOAT[] DEFAULT []`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Task ADD embedding FLOAT[] DEFAULT []`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Task ADD doneSuggestion STRING DEFAULT ''`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Task ADD activatedAt STRING DEFAULT ''`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Task ADD branch STRING DEFAULT ''`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Task ADD prUrl STRING DEFAULT ''`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Task ADD githubPrUrl STRING DEFAULT ''`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Task ADD githubIssueId STRING DEFAULT ''`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Session ADD embedding FLOAT[] DEFAULT []`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Memory ADD decisionStatus STRING DEFAULT 'pending'`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Memory ADD statusUpdatedAt STRING DEFAULT ''`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Memory ADD statusNote STRING DEFAULT ''`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Turn ADD summary STRING DEFAULT ''`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE Turn ADD summarizedAt STRING DEFAULT ''`); } catch { /* exists */ }

  // Edge property migrations
  try { await conn.query(`ALTER TABLE HAS_TURN ADD turnIndex INT64 DEFAULT -1`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE REFERENCES ADD accessType STRING DEFAULT 'read'`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE HAS_MEMORY ADD extractedFrom STRING DEFAULT ''`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE RELATED_TO ADD model STRING DEFAULT ''`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE LINKED ADD source STRING DEFAULT 'human'`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE LINKED ADD confidence FLOAT DEFAULT 1.0`); } catch { /* exists */ }
  try { await conn.query(`ALTER TABLE LINKED ADD sessionId STRING DEFAULT ''`); } catch { /* exists */ }

  // Migration: recreate RELATED_TO with score + createdAt properties
  try {
    const result = await conn.query(`CALL table_info('RELATED_TO') RETURN *`);
    const qr = Array.isArray(result) ? result[0] : result;
    const cols = await (qr as { getAll(): Promise<Record<string, unknown>[]> }).getAll();
    const hasScore = cols.some((c) => c["name"] === "score");
    if (!hasScore) {
      await conn.query(`DROP TABLE RELATED_TO`);
      await conn.query(`CREATE REL TABLE RELATED_TO(FROM Memory TO Memory, score FLOAT, createdAt STRING, model STRING)`);
    }
  } catch { /* table didn't exist yet — created fresh by applySchema above */ }

  // Backfill: connect orphaned Task nodes to their Project via HAS_TASK
  try {
    await conn.query(
      `MATCH (t:Task)
       WHERE NOT EXISTS { MATCH (p:Project)-[:HAS_TASK]->(t) }
       MATCH (p:Project {id: t.projectId})
       CREATE (p)-[:HAS_TASK]->(t)`
    );
  } catch { /* no orphans or table doesn't exist yet */ }

  // Backfill: create MENTIONS edges between Task and Memory nodes in same session
  try {
    const now = new Date().toISOString();
    await conn.query(
      `MATCH (sess:Session)-[:WORKED_ON]->(t:Task)
       MATCH (sess)-[:HAS_MEMORY]->(m:Memory)
       WHERE NOT EXISTS { MATCH (t)-[:MENTIONS]->(m) }
       CREATE (t)-[:MENTIONS {createdAt: '${escape(now)}'}]->(m)`
    );
  } catch { /* no WORKED_ON relationships or edge already exists */ }

  // Backfill: create RELATED_TO edges for memories that have none yet
  try {
    const RELATED_THRESHOLD = 0.82;
    const result = await conn.query(
      `MATCH (m:Memory) WHERE size(m.embedding) > 0
       AND NOT EXISTS { MATCH (m)-[:RELATED_TO]->(:Memory) }
       RETURN m`
    );
    const qr = Array.isArray(result) ? result[0] : result;
    const unlinked = await (qr as { getAll(): Promise<Record<string, unknown>[]> }).getAll();

    if (unlinked.length > 0) {
      const allResult = await conn.query(`MATCH (m:Memory) WHERE size(m.embedding) > 0 RETURN m`);
      const aqr = Array.isArray(allResult) ? allResult[0] : allResult;
      const all = await (aqr as { getAll(): Promise<Record<string, unknown>[]> }).getAll();

      for (const row of unlinked) {
        const a = row["m"] as { id: string; embedding: number[] };
        const now = new Date().toISOString();
        for (const other of all) {
          const b = other["m"] as { id: string; embedding: number[] };
          if (a.id === b.id) continue;
          const sim = cosineSimilarity(a.embedding, b.embedding);
          if (sim >= RELATED_THRESHOLD) {
            const score = Math.round(sim * 10000) / 10000;
            await conn.query(
              `MATCH (a:Memory {id: '${a.id}'}), (b:Memory {id: '${b.id}'})
               WHERE NOT EXISTS { MATCH (a)-[:RELATED_TO]->(b) }
               CREATE (a)-[:RELATED_TO {score: ${score}, createdAt: '${now}'}]->(b)`
            );
          }
        }
      }
    }
  } catch { /* best-effort */ }

  // Backfill: index existing JSONL session turns as Turn nodes
  if (projectMemoryDir) {
    backfillTurns(conn, projectMemoryDir).catch(() => {});
  }
}

export function extractFilePaths(text: string): string[] {
  const paths = new Set<string>();
  const mdLink = /\[[^\]]*\]\(([^)#\s]+)/g;
  let m;
  while ((m = mdLink.exec(text)) !== null) {
    const p = m[1];
    if (p.startsWith("http://") || p.startsWith("https://")) continue;
    if (/\.\w+$/.test(p) || p.includes("/")) paths.add(p);
  }
  return [...paths];
}

function langFromPath(p: string): string {
  const ext = p.split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx",
    py: "py", go: "go", rs: "rs", java: "java",
    md: "md", json: "json", yaml: "yaml", yml: "yaml",
  };
  return map[ext] ?? ext;
}

async function backfillTurns(
  conn: InstanceType<typeof kuzu.Connection>,
  projectMemoryDir: string
): Promise<void> {
  const sessionsDir = path.join(projectMemoryDir, "sessions");
  if (!fs.existsSync(sessionsDir)) return;

  const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));

  for (const file of files) {
    const sessionId = file.replace(".jsonl", "");
    const lines = fs.readFileSync(path.join(sessionsDir, file), "utf-8")
      .split("\n").filter((l) => l.trim());

    for (const line of lines) {
      let entry: { turnId: string; timestamp: string; messages: Array<{ role: string; content: string }>; files?: string[] };
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry.turnId) continue;

      // Skip if already in DB
      const existing = await conn.query(`MATCH (t:Turn {id: '${escape(entry.turnId)}'}) RETURN t.id`);
      const eqr = Array.isArray(existing) ? existing[0] : existing;
      const erows = await (eqr as { getAll(): Promise<Record<string, unknown>[]> }).getAll();
      if (erows.length > 0) continue;

      const userText = (entry.messages.find((m) => m.role === "user")?.content ?? "").slice(0, 400);
      const assistantText = (entry.messages.find((m) => m.role === "assistant")?.content ?? "").slice(0, 400);

      // Determine projectId from session node if available
      const sRows = await conn.query(`MATCH (s:Session {id: '${escape(sessionId)}'}) RETURN s.projectId`);
      const sqr = Array.isArray(sRows) ? sRows[0] : sRows;
      const sdata = await (sqr as { getAll(): Promise<Record<string, unknown>[]> }).getAll();
      const projectId = sdata.length > 0 ? String(sdata[0]["s.projectId"] ?? "") : "";
      if (!projectId) continue;

      // Extract file paths from messages
      const allText = entry.messages.map((m) => m.content).join(" ");
      const filePaths = extractFilePaths(allText);

      // Build embed text
      const filesSuffix = filePaths.length > 0 ? `\nfiles: ${filePaths.join(", ")}` : "";
      const embedText = `user: ${userText}\nassistant: ${assistantText}${filesSuffix}`;

      await conn.query(
        `CREATE (t:Turn {
          id: '${escape(entry.turnId)}',
          sessionId: '${escape(sessionId)}',
          projectId: '${escape(projectId)}',
          timestamp: '${escape(entry.timestamp)}',
          userText: '${escape(userText)}',
          assistantText: '${escape(assistantText)}',
          embedding: []
        })`
      );

      // Wire Session → Turn (with turnIndex = current count before this turn)
      const cntResult = await conn.query(
        `MATCH (s:Session {id: '${escape(sessionId)}'})-[:HAS_TURN]->(t:Turn) RETURN count(t) AS cnt`
      );
      const cntQr = Array.isArray(cntResult) ? cntResult[0] : cntResult;
      const cntRows2 = await (cntQr as { getAll(): Promise<Record<string, unknown>[]> }).getAll();
      const turnIndex = Number(cntRows2[0]?.["cnt"] ?? 0);
      await conn.query(
        `MATCH (s:Session {id: '${escape(sessionId)}'}), (t:Turn {id: '${escape(entry.turnId)}'})
         WHERE NOT EXISTS { MATCH (s)-[:HAS_TURN]->(t) }
         CREATE (s)-[:HAS_TURN {turnIndex: ${turnIndex}}]->(t)`
      ).catch(() => {});

      // Upsert File nodes + REFERENCES edges
      for (const fp of filePaths) {
        const fileId = `${projectId}:${fp}`;
        const lang = langFromPath(fp);
        const now = entry.timestamp;
        const chk = await conn.query(`MATCH (f:File {id: '${escape(fileId)}'}) RETURN f.id`);
        const cqr = Array.isArray(chk) ? chk[0] : chk;
        const crow = await (cqr as { getAll(): Promise<Record<string, unknown>[]> }).getAll();
        if (crow.length === 0) {
          await conn.query(
            `CREATE (f:File {id: '${escape(fileId)}', path: '${escape(fp)}',
              projectId: '${escape(projectId)}', language: '${escape(lang)}',
              lastSeenAt: '${escape(now)}'})`
          ).catch(() => {});
        } else {
          await conn.query(
            `MATCH (f:File {id: '${escape(fileId)}'}) SET f.lastSeenAt = '${escape(now)}'`
          ).catch(() => {});
        }

        await conn.query(
          `MATCH (t:Turn {id: '${escape(entry.turnId)}'}), (f:File {id: '${escape(fileId)}'})
           WHERE NOT EXISTS { MATCH (t)-[:REFERENCES]->(f) }
           CREATE (t)-[:REFERENCES {accessType: 'read'}]->(f)`
        ).catch(() => {});
      }

      // Embed async — fire and forget
      embed(embedText).then((vec) => {
        const literal = `[${vec.join(", ")}]`;
        conn.query(`MATCH (t:Turn {id: '${escape(entry.turnId)}'}) SET t.embedding = ${literal}`).catch(() => {});
      }).catch(() => {});
    }
  }
}
