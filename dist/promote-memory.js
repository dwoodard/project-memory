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
Object.defineProperty(exports, "__esModule", { value: true });
exports.promoteMemories = promoteMemories;
const crypto = __importStar(require("crypto"));
const kuzu_helpers_js_1 = require("./kuzu-helpers.js");
function escape(s) {
    return (s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
async function promoteMemories(candidates, sessionId, config, conn) {
    const promoted = [];
    for (const candidate of candidates) {
        // Dedupe: check if a memory with the same title already exists
        const rows = await (0, kuzu_helpers_js_1.queryAll)(conn, `MATCH (m:Memory {projectId: '${escape(config.projectId)}'})
       WHERE m.title = '${escape(candidate.title)}'
       RETURN m.id`);
        if (rows.length > 0)
            continue; // already known
        const memory = {
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
        await conn.query(`CREATE (m:Memory {
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
      })`);
        // Link memory to session
        await conn.query(`MATCH (s:Session {id: '${escape(sessionId)}'}), (m:Memory {id: '${escape(memory.id)}'})
       CREATE (s)-[:HAS_MEMORY]->(m)`);
        promoted.push(memory);
    }
    return promoted;
}
