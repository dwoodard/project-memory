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
exports.initProject = initProject;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const detect_project_js_1 = require("./detect-project.js");
const db_js_1 = require("./db.js");
const config_js_1 = require("./config.js");
async function initProject(cwd) {
    const detected = (0, detect_project_js_1.detectProject)(cwd);
    if (!detected) {
        throw new Error("Not inside a git repository. Run git init first.");
    }
    const { repoRoot, remoteUrl, projectName } = detected;
    const projectMemoryDir = path.join(repoRoot, ".project-memory");
    const configPath = path.join(projectMemoryDir, "config.json");
    // Idempotent — check if already initialized
    if (fs.existsSync(configPath)) {
        const existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        console.log(`Already initialized: ${existing.projectName} (${existing.projectId})`);
        return;
    }
    // Create directory structure
    for (const dir of [
        projectMemoryDir,
        path.join(projectMemoryDir, "sessions"),
        path.join(projectMemoryDir, "candidates"),
        path.join(projectMemoryDir, "artifacts"),
        path.join(projectMemoryDir, "summaries"),
        path.join(projectMemoryDir, "queue"),
    ]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    // Initialize Kuzu and apply schema
    const { conn } = (0, db_js_1.getDb)(projectMemoryDir);
    await (0, db_js_1.applySchema)(conn);
    // Write config with LLM defaults
    const projectId = `proj_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const config = {
        projectId,
        projectName,
        remoteUrl,
        repoPath: repoRoot,
        createdAt: new Date().toISOString(),
        llm: { ...config_js_1.DEFAULT_LLM },
        embedding: { ...config_js_1.DEFAULT_EMBEDDING },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    // Create Project node in Kuzu
    await conn.query(`CREATE (p:Project {
      id: '${projectId}',
      name: '${projectName.replace(/'/g, "\\'")}',
      remoteUrl: '${remoteUrl.replace(/'/g, "\\'")}',
      repoPath: '${repoRoot.replace(/'/g, "\\'")}',
      createdAt: '${config.createdAt}'
    })`);
    // Add .project-memory to .gitignore
    const gitignorePath = path.join(repoRoot, ".gitignore");
    const entry = ".project-memory/\n";
    if (fs.existsSync(gitignorePath)) {
        const contents = fs.readFileSync(gitignorePath, "utf-8");
        if (!contents.includes(".project-memory"))
            fs.appendFileSync(gitignorePath, `\n${entry}`);
    }
    else {
        fs.writeFileSync(gitignorePath, entry);
    }
    // Write .claude/settings.json with hook registrations
    writeClaudeSettings(repoRoot);
    console.log(`Initialized project: ${projectName}`);
    console.log(`  ID:     ${projectId}`);
    console.log(`  Remote: ${remoteUrl}`);
    console.log(`  Path:   ${projectMemoryDir}`);
    console.log(`  Hooks:  .claude/settings.json`);
    console.log(`  Run "project-memory config" to set your LLM and embedding models.`);
}
function writeClaudeSettings(repoRoot) {
    const claudeDir = path.join(repoRoot, ".claude");
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.mkdirSync(claudeDir, { recursive: true });
    // The hook commands use "project-memory hook <type>" — portable, no hardcoded paths.
    // Requires project-memory to be on PATH (npm install -g project-memory).
    const hookEntry = (type) => ({
        matcher: "",
        hooks: [{ type: "command", command: `project-memory hook ${type}` }],
    });
    let existing = {};
    if (fs.existsSync(settingsPath)) {
        try {
            existing = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        }
        catch { /* ignore */ }
    }
    // Merge — don't overwrite other settings the project may already have
    const hooks = existing["hooks"] ?? {};
    const upsertHook = (event, type) => {
        const entries = hooks[event] ?? [];
        const cmd = `project-memory hook ${type}`;
        const alreadyPresent = entries.some((e) => e.hooks?.some((h) => h.command === cmd));
        if (!alreadyPresent)
            entries.push(hookEntry(type));
        hooks[event] = entries;
    };
    upsertHook("SessionStart", "session-start");
    upsertHook("UserPromptSubmit", "user-prompt");
    upsertHook("Stop", "stop");
    upsertHook("PreCompact", "compact");
    upsertHook("PostToolUse", "post-tool-use");
    existing["hooks"] = hooks;
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
}
