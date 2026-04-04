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
exports.appendTurn = appendTurn;
exports.resolveSession = resolveSession;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
function appendTurn(turn, projectMemoryDir, sessionId) {
    const sessionsDir = path.join(projectMemoryDir, "sessions");
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    const entry = {
        turnId: `turn_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
        timestamp: turn.timestamp,
        messages: turn.messages,
        files: turn.files ?? [],
    };
    fs.appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
    return entry.turnId;
}
function resolveSession(turn, projectMemoryDir, config) {
    // Use the client-provided sessionId if present, otherwise derive one per day
    if (turn.sessionId)
        return turn.sessionId;
    const date = new Date(turn.timestamp).toISOString().slice(0, 10);
    return `${config.projectId}_${date}`;
}
