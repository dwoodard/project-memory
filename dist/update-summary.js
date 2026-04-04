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
exports.getSummaryPath = getSummaryPath;
exports.readSummary = readSummary;
exports.writeSummary = writeSummary;
exports.buildUpdatedSummary = buildUpdatedSummary;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function getSummaryPath(projectMemoryDir, sessionId) {
    return path.join(projectMemoryDir, "summaries", `${sessionId}.md`);
}
function readSummary(projectMemoryDir, sessionId) {
    const summaryPath = getSummaryPath(projectMemoryDir, sessionId);
    if (!fs.existsSync(summaryPath))
        return "";
    return fs.readFileSync(summaryPath, "utf-8");
}
function writeSummary(projectMemoryDir, sessionId, summary) {
    const summaryPath = getSummaryPath(projectMemoryDir, sessionId);
    fs.writeFileSync(summaryPath, summary);
}
function buildUpdatedSummary(existingSummary, turn) {
    // This is called after extract-memory with the LLM-generated summary update.
    // For now, append a timestamped entry. The real update happens via the extraction prompt.
    const userMsg = turn.messages.find((m) => m.role === "user")?.content ?? "";
    const assistantMsg = turn.messages.find((m) => m.role === "assistant")?.content ?? "";
    const truncate = (s, n) => s.length > n ? s.slice(0, n) + "..." : s;
    const newEntry = [
        `[${turn.timestamp}]`,
        `User: ${truncate(userMsg, 200)}`,
        `Assistant: ${truncate(assistantMsg, 200)}`,
    ].join("\n");
    if (!existingSummary)
        return newEntry;
    return existingSummary + "\n\n---\n\n" + newEntry;
}
