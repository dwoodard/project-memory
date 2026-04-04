"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assembleContext = assembleContext;
exports.formatContextBundle = formatContextBundle;
const kuzu_helpers_js_1 = require("./kuzu-helpers.js");
function escape(s) {
    return (s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
async function assembleContext(projectId, sessionSummary, conn) {
    // Get active task
    const activeRows = await (0, kuzu_helpers_js_1.queryAll)(conn, `MATCH (m:Memory {projectId: '${escape(projectId)}', kind: 'task', status: 'active'})
     RETURN m ORDER BY m.createdAt DESC LIMIT 1`);
    const activeTask = activeRows.length > 0 ? activeRows[0]["m"] : null;
    // Get next pending tasks
    const pendingRows = await (0, kuzu_helpers_js_1.queryAll)(conn, `MATCH (m:Memory {projectId: '${escape(projectId)}', kind: 'task', status: 'pending'})
     RETURN m ORDER BY m.createdAt ASC LIMIT 3`);
    const nextTasks = pendingRows.map((r) => r["m"]);
    // Get key memories — decisions first, then questions, then facts
    const memoriesRows = await (0, kuzu_helpers_js_1.queryAll)(conn, `MATCH (m:Memory {projectId: '${escape(projectId)}'})
     WHERE m.kind IN ['decision', 'question', 'fact', 'summary']
     RETURN m ORDER BY m.createdAt DESC LIMIT 5`);
    const keyMemories = memoriesRows.map((r) => r["m"]);
    return {
        activeTask,
        nextTasks,
        keyMemories,
        sessionSummary,
    };
}
function formatContextBundle(bundle) {
    const lines = ["## Project Memory Context\n"];
    if (bundle.activeTask) {
        lines.push(`### Active Task\n${bundle.activeTask.title}`);
        if (bundle.activeTask.summary)
            lines.push(bundle.activeTask.summary);
        lines.push("");
    }
    if (bundle.nextTasks.length > 0) {
        lines.push("### Next Tasks");
        bundle.nextTasks.forEach((t) => lines.push(`- ${t.title}`));
        lines.push("");
    }
    if (bundle.keyMemories.length > 0) {
        lines.push("### Key Context");
        bundle.keyMemories.forEach((m) => {
            lines.push(`**[${m.kind}]** ${m.title}: ${m.summary}`);
        });
        lines.push("");
    }
    if (bundle.sessionSummary) {
        lines.push("### Session Summary");
        lines.push(bundle.sessionSummary);
    }
    return lines.join("\n");
}
