/**
 * Integration test for graph-walk context assembly.
 *
 * Uses a real (tmp) Kuzu DB, synthetic memories with hand-crafted embeddings,
 * and stubs `embed` so no LLM server is needed.
 *
 * Run: npx tsx src/test-graph-walk.ts
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import kuzu from "kuzu";
import { applySchema } from "./db.js";
import { escape, queryAll } from "./kuzu-helpers.js";
import { cosineSimilarity, searchMemoriesWithGraph } from "./search.js";

// ── Stub embed ───────────────────────────────────────────────────────────────
// Simple 4-d unit vectors — easy to reason about similarity
const VECS: Record<string, number[]> = {
  // "auth / security" cluster
  auth:        [1, 0, 0, 0],
  session:     [0.95, 0.31, 0, 0],
  token:       [0.9, 0.1, 0.4, 0],
  // "database" cluster
  db:          [0, 1, 0, 0],
  migration:   [0, 0.95, 0.31, 0],
  schema:      [0, 0.9, 0.1, 0.4],
  // "UI" cluster — unrelated
  button:      [0, 0, 0, 1],
  // query vector — close to auth cluster
  query:       [0.98, 0.2, 0, 0],
};

function normalize(v: number[]): number[] {
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / len);
}

// Stub embed — no LLM needed
async function stubEmbed(text: string): Promise<number[]> {
  const key = Object.keys(VECS).find((k) => text.toLowerCase().includes(k));
  return normalize(key ? VECS[key] : VECS["button"]); // default: unrelated
}

// ── Test helpers ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    failed++;
  }
}

// ── DB setup ─────────────────────────────────────────────────────────────────
async function makeDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pensieve-test-"));
  const dbPath = path.join(tmpDir, "test.kz");
  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);
  await applySchema(conn);
  return { conn, tmpDir };
}

function vec(key: keyof typeof VECS): number[] {
  return normalize(VECS[key]);
}

async function insertMemory(
  conn: InstanceType<typeof kuzu.Connection>,
  opts: {
    id: string;
    title: string;
    kind?: string;
    sessionId: string;
    projectId: string;
    embedding: number[];
    createdAt?: string;
  }
) {
  const literal = `[${opts.embedding.join(", ")}]`;
  await conn.query(
    `CREATE (m:Memory {
      id: '${escape(opts.id)}',
      kind: '${opts.kind ?? "fact"}',
      title: '${escape(opts.title)}',
      summary: '${escape(opts.title)}',
      recallCue: '',
      projectId: '${escape(opts.projectId)}',
      sessionId: '${escape(opts.sessionId)}',
      createdAt: '${opts.createdAt ?? new Date().toISOString()}',
      status: '',
      taskOrder: 0,
      embedding: ${literal}
    })`
  );
}

async function insertSession(
  conn: InstanceType<typeof kuzu.Connection>,
  opts: { id: string; projectId: string; title: string; summary?: string }
) {
  await conn.query(
    `CREATE (s:Session {
      id: '${escape(opts.id)}',
      projectId: '${escape(opts.projectId)}',
      startedAt: '${new Date().toISOString()}',
      title: '${escape(opts.title)}',
      summary: '${escape(opts.summary ?? "")}',
      archived: false
    })`
  );
}

async function linkSessionMemory(
  conn: InstanceType<typeof kuzu.Connection>,
  sessionId: string,
  memoryId: string
) {
  await conn.query(
    `MATCH (s:Session {id: '${escape(sessionId)}'}), (m:Memory {id: '${escape(memoryId)}'})
     CREATE (s)-[:HAS_MEMORY]->(m)`
  );
}

async function linkRelated(
  conn: InstanceType<typeof kuzu.Connection>,
  fromId: string,
  toId: string
) {
  await conn.query(
    `MATCH (a:Memory {id: '${escape(fromId)}'}), (b:Memory {id: '${escape(toId)}'})
     CREATE (a)-[:RELATED_TO]->(b)`
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────
async function testCosineSimilarity() {
  console.log("\n── cosineSimilarity ─────────────────────────────");
  const a = normalize([1, 0, 0, 0]);
  const b = normalize([1, 0, 0, 0]);
  const c = normalize([0, 1, 0, 0]);
  assert(Math.abs(cosineSimilarity(a, b) - 1.0) < 0.001, "identical vectors → 1.0");
  assert(Math.abs(cosineSimilarity(a, c)) < 0.001,        "orthogonal vectors → 0.0");
  assert(cosineSimilarity(normalize([1, 1, 0, 0]), a) > 0.5, "partial overlap → > 0.5");
}

async function testGraphWalkRetrieval() {
  console.log("\n── searchMemoriesWithGraph ──────────────────────");
  const { conn, tmpDir } = await makeDb();
  const pid = "proj_test";

  // Session A: auth-related memories
  await insertSession(conn, { id: "sess_a", projectId: pid, title: "Auth session", summary: "Worked on authentication" });
  await insertMemory(conn, { id: "mem_auth",    title: "auth decision",    sessionId: "sess_a", projectId: pid, embedding: vec("auth") });
  await insertMemory(conn, { id: "mem_token",   title: "token handling",   sessionId: "sess_a", projectId: pid, embedding: vec("token") });
  await insertMemory(conn, { id: "mem_session", title: "session mgmt",     sessionId: "sess_a", projectId: pid, embedding: vec("session") });
  await linkSessionMemory(conn, "sess_a", "mem_auth");
  await linkSessionMemory(conn, "sess_a", "mem_token");
  await linkSessionMemory(conn, "sess_a", "mem_session");

  // Session B: db-related memories (unrelated to query)
  await insertSession(conn, { id: "sess_b", projectId: pid, title: "DB session", summary: "Worked on migrations" });
  await insertMemory(conn, { id: "mem_db",        title: "db schema",     sessionId: "sess_b", projectId: pid, embedding: vec("db") });
  await insertMemory(conn, { id: "mem_migration", title: "migration fix",  sessionId: "sess_b", projectId: pid, embedding: vec("migration") });
  await linkSessionMemory(conn, "sess_b", "mem_db");
  await linkSessionMemory(conn, "sess_b", "mem_migration");

  // Unrelated: UI memory with no session link
  await insertMemory(conn, { id: "mem_button", title: "button styling", sessionId: "sess_c", projectId: pid, embedding: vec("button") });

  // Query close to auth cluster
  const results = await searchMemoriesWithGraph(conn, pid, "auth token", 8, 3, stubEmbed);
  const ids = results.map((r) => r.id);

  assert(ids.includes("mem_auth"),    "seed hit: mem_auth returned");
  assert(ids.includes("mem_token"),   "seed hit: mem_token returned");
  assert(ids.includes("mem_session"), "session sibling: mem_session pulled in via sess_a");
  assert(!ids.includes("mem_button"), "unrelated UI memory excluded");

  // Top result should be auth-cluster
  assert(results[0].score > results[results.length - 1].score, "results sorted by score descending");

  // Session title propagated
  const authResult = results.find((r) => r.id === "mem_auth");
  assert(authResult?.sessionTitle === "Auth session", "sessionTitle attached to seed memory");

  fs.rmSync(tmpDir, { recursive: true });
}

async function testRelatedToTraversal() {
  console.log("\n── RELATED_TO traversal ─────────────────────────");
  const { conn, tmpDir } = await makeDb();
  const pid = "proj_test2";

  await insertSession(conn, { id: "sess_x", projectId: pid, title: "Schema session" });
  await insertMemory(conn, { id: "mem_schema",    title: "schema design",   sessionId: "sess_x", projectId: pid, embedding: vec("schema") });
  await insertMemory(conn, { id: "mem_migration2",title: "migration steps", sessionId: "sess_x", projectId: pid, embedding: vec("migration") });
  // mem_schema has no session link but IS linked via RELATED_TO from mem_migration2
  await insertMemory(conn, { id: "mem_db2",       title: "db indexes",      sessionId: "sess_x", projectId: pid, embedding: vec("db") });
  await linkSessionMemory(conn, "sess_x", "mem_migration2");
  // Wire RELATED_TO: migration2 → schema
  await linkRelated(conn, "mem_migration2", "mem_schema");

  // Query close to db/migration cluster
  const results = await searchMemoriesWithGraph(conn, pid, "db migration", 8, 2, stubEmbed);
  const ids = results.map((r) => r.id);

  assert(ids.includes("mem_migration2"), "seed: mem_migration2 found");
  assert(ids.includes("mem_schema"),     "RELATED_TO hop: mem_schema pulled in");

  fs.rmSync(tmpDir, { recursive: true });
}

async function testRecencyDecay() {
  console.log("\n── recency decay ────────────────────────────────");
  const { conn, tmpDir } = await makeDb();
  const pid = "proj_test3";

  const old  = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
  const recent = new Date().toISOString();

  await insertSession(conn, { id: "sess_r", projectId: pid, title: "Recent" });
  // Both have identical embeddings — recency should break the tie
  await insertMemory(conn, { id: "mem_old",    title: "old auth fact",    sessionId: "sess_r", projectId: pid, embedding: vec("auth"), createdAt: old });
  await insertMemory(conn, { id: "mem_recent", title: "recent auth fact", sessionId: "sess_r", projectId: pid, embedding: vec("auth"), createdAt: recent });

  const results = await searchMemoriesWithGraph(conn, pid, "auth", 8, 2, stubEmbed);
  const recentIdx = results.findIndex((r) => r.id === "mem_recent");
  const oldIdx    = results.findIndex((r) => r.id === "mem_old");

  assert(recentIdx < oldIdx, "recent memory ranks above old memory with equal similarity");

  fs.rmSync(tmpDir, { recursive: true });
}

// ── Run ───────────────────────────────────────────────────────────────────────
(async () => {
  console.log("pensieve graph-walk tests\n");
  try {
    await testCosineSimilarity();
    await testGraphWalkRetrieval();
    await testRelatedToTraversal();
    await testRecencyDecay();
  } catch (e) {
    console.error("\nUnhandled error:", e);
    process.exit(1);
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
