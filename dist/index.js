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
exports.ingestTurn = ingestTurn;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const detect_project_js_1 = require("./detect-project.js");
const db_js_1 = require("./db.js");
const kuzu_helpers_js_1 = require("./kuzu-helpers.js");
const append_turn_js_1 = require("./append-turn.js");
const extract_memory_js_1 = require("./extract-memory.js");
const promote_memory_js_1 = require("./promote-memory.js");
const update_summary_js_1 = require("./update-summary.js");
async function ingestTurn(turn, extractFn) {
    const detected = (0, detect_project_js_1.detectProject)(turn.cwd);
    if (!detected) {
        console.error("No git repo found at:", turn.cwd);
        return;
    }
    const { repoRoot } = detected;
    const projectMemoryDir = path.join(repoRoot, ".project-memory");
    const configPath = path.join(projectMemoryDir, "config.json");
    if (!fs.existsSync(configPath)) {
        console.error("Project not initialized. Run: project-memory init");
        return;
    }
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const { conn } = (0, db_js_1.getDb)(projectMemoryDir);
    // 1. Resolve session
    const sessionId = (0, append_turn_js_1.resolveSession)(turn, projectMemoryDir, config);
    // Ensure session exists in DB
    const sessionRows = await (0, kuzu_helpers_js_1.queryAll)(conn, `MATCH (s:Session {id: '${sessionId}'}) RETURN s`);
    if (sessionRows.length === 0) {
        await conn.query(`CREATE (s:Session {
        id: '${sessionId}',
        projectId: '${config.projectId}',
        startedAt: '${new Date().toISOString()}',
        summary: ''
      })`);
        await conn.query(`MATCH (p:Project {id: '${config.projectId}'}), (s:Session {id: '${sessionId}'})
       CREATE (p)-[:HAS_SESSION]->(s)`);
    }
    // 2. Append turn to session log
    const turnId = (0, append_turn_js_1.appendTurn)(turn, projectMemoryDir, sessionId);
    // 3. Read existing session summary
    const existingSummary = (0, update_summary_js_1.readSummary)(projectMemoryDir, sessionId);
    // 4. Extract candidate memories (if extraction function provided)
    if (extractFn) {
        const prompt = (0, extract_memory_js_1.buildExtractionPrompt)(turn, existingSummary, config.projectName);
        try {
            const response = await extractFn(prompt);
            const candidates = (0, extract_memory_js_1.parseCandidates)(response);
            if (candidates.length > 0) {
                (0, extract_memory_js_1.writeCandidates)(candidates, projectMemoryDir, sessionId, turnId);
                const promoted = await (0, promote_memory_js_1.promoteMemories)(candidates, sessionId, config, conn);
                if (promoted.length > 0) {
                    console.log(`Promoted ${promoted.length} memory(s):`, promoted.map((m) => `[${m.kind}] ${m.title}`).join(", "));
                }
            }
        }
        catch (err) {
            console.error("Memory extraction failed:", err);
        }
    }
    // 5. Update rolling session summary
    const updatedSummary = (0, update_summary_js_1.buildUpdatedSummary)(existingSummary, turn);
    (0, update_summary_js_1.writeSummary)(projectMemoryDir, sessionId, updatedSummary);
}
