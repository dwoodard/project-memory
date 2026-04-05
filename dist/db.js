"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
exports.applySchema = applySchema;
const kuzu_1 = __importDefault(require("kuzu"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const _cache = new Map();
function getDb(projectMemoryDir) {
    const cached = _cache.get(projectMemoryDir);
    if (cached)
        return cached;
    // Explorer expects KUZU_DIR/database.kz — create the parent dir and use that filename
    const graphDir = path.join(projectMemoryDir, "graph");
    fs.mkdirSync(graphDir, { recursive: true });
    const dbPath = path.join(graphDir, "database.kz");
    const db = new kuzu_1.default.Database(dbPath);
    const conn = new kuzu_1.default.Connection(db);
    _cache.set(projectMemoryDir, { db, conn });
    return { db, conn };
}
async function applySchema(conn) {
    const statements = [
        `CREATE NODE TABLE IF NOT EXISTS Project(
      id STRING,
      name STRING,
      remoteUrl STRING,
      repoPath STRING,
      createdAt STRING,
      PRIMARY KEY (id)
    )`,
        `CREATE NODE TABLE IF NOT EXISTS Session(
      id STRING,
      projectId STRING,
      startedAt STRING,
      title STRING,
      summary STRING,
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
      artifactId STRING,
      PRIMARY KEY (id)
    )`,
        `CREATE NODE TABLE IF NOT EXISTS Artifact(
      id STRING,
      type STRING,
      title STRING,
      summary STRING,
      location STRING,
      projectId STRING,
      sessionId STRING,
      createdAt STRING,
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
      PRIMARY KEY (id)
    )`,
        `CREATE REL TABLE IF NOT EXISTS HAS_SESSION(FROM Project TO Session)`,
        `CREATE REL TABLE IF NOT EXISTS HAS_TASK(FROM Project TO Task)`,
        `CREATE REL TABLE IF NOT EXISTS HAS_MEMORY(FROM Session TO Memory)`,
        `CREATE REL TABLE IF NOT EXISTS PRODUCED(FROM Session TO Artifact)`,
        `CREATE REL TABLE IF NOT EXISTS REFERS_TO(FROM Memory TO Artifact)`,
        `CREATE REL TABLE IF NOT EXISTS SUPERSEDES(FROM Memory TO Memory)`,
        `CREATE REL TABLE IF NOT EXISTS RELATED_TO(FROM Memory TO Memory)`,
    ];
    for (const stmt of statements) {
        await conn.query(stmt);
    }
    // Migration: move task Memory nodes → Task nodes
    try {
        const taskMemories = await conn.query(`MATCH (m:Memory {kind: 'task'}) RETURN m`);
        const qr = Array.isArray(taskMemories) ? taskMemories[0] : taskMemories;
        const rows = await qr.getAll();
        for (const row of rows) {
            const m = row["m"];
            const id = String(m["id"]);
            const esc = (s) => (s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
            // Check if already migrated
            const existing = await conn.query(`MATCH (t:Task {id: '${esc(id)}'}) RETURN t.id`);
            const eqr = Array.isArray(existing) ? existing[0] : existing;
            const erows = await eqr.getAll();
            if (erows.length > 0)
                continue;
            const status = String(m["status"] || "pending");
            const taskOrder = Number(m["taskOrder"] ?? 0);
            const projectId = String(m["projectId"] ?? "");
            await conn.query(`CREATE (t:Task {
          id: '${esc(id)}',
          title: '${esc(String(m["title"] ?? ""))}',
          summary: '${esc(String(m["summary"] ?? ""))}',
          status: '${esc(status)}',
          taskOrder: ${taskOrder},
          projectId: '${esc(projectId)}',
          createdAt: '${esc(String(m["createdAt"] ?? new Date().toISOString()))}'
        })`);
            await conn.query(`MATCH (p:Project {id: '${esc(projectId)}'}), (t:Task {id: '${esc(id)}'})
         CREATE (p)-[:HAS_TASK]->(t)`);
        }
        // Remove migrated task Memory nodes
        if (rows.length > 0) {
            await conn.query(`MATCH (m:Memory {kind: 'task'}) DETACH DELETE m`);
        }
    }
    catch {
        // Migration already done or no task memories exist
    }
    // Column migrations — safe to ignore if already applied
    try {
        await conn.query(`ALTER TABLE Memory ADD taskOrder INT64 DEFAULT 0`);
    }
    catch { /* exists */ }
    try {
        await conn.query(`ALTER TABLE Session ADD title STRING DEFAULT ''`);
    }
    catch { /* exists */ }
    // Backfill: connect orphaned Task nodes to their Project via HAS_TASK
    try {
        await conn.query(`MATCH (t:Task)
       WHERE NOT EXISTS { MATCH (p:Project)-[:HAS_TASK]->(t) }
       MATCH (p:Project {id: t.projectId})
       CREATE (p)-[:HAS_TASK]->(t)`);
    }
    catch { /* no orphans or table doesn't exist yet */ }
}
