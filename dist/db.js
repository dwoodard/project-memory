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
const path = __importStar(require("path"));
let _db = null;
let _conn = null;
function getDb(projectMemoryDir) {
    if (_db && _conn)
        return { db: _db, conn: _conn };
    const kuzuDir = path.join(projectMemoryDir, "kuzu");
    // Kuzu creates the directory itself — do not pre-create it
    _db = new kuzu_1.default.Database(kuzuDir);
    _conn = new kuzu_1.default.Connection(_db);
    return { db: _db, conn: _conn };
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
        `CREATE REL TABLE IF NOT EXISTS HAS_SESSION(FROM Project TO Session)`,
        `CREATE REL TABLE IF NOT EXISTS HAS_MEMORY(FROM Session TO Memory)`,
        `CREATE REL TABLE IF NOT EXISTS PRODUCED(FROM Session TO Artifact)`,
        `CREATE REL TABLE IF NOT EXISTS REFERS_TO(FROM Memory TO Artifact)`,
        `CREATE REL TABLE IF NOT EXISTS SUPERSEDES(FROM Memory TO Memory)`,
        `CREATE REL TABLE IF NOT EXISTS RELATED_TO(FROM Memory TO Memory)`,
    ];
    for (const stmt of statements) {
        await conn.query(stmt);
    }
}
