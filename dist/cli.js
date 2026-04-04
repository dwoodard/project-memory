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
const commander_1 = require("commander");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const init_js_1 = require("./init.js");
const index_js_1 = require("./index.js");
const assemble_context_js_1 = require("./assemble-context.js");
const detect_project_js_1 = require("./detect-project.js");
const db_js_1 = require("./db.js");
const update_summary_js_1 = require("./update-summary.js");
const program = new commander_1.Command();
program
    .name("project-memory")
    .description("Deterministic memory system for AI-assisted coding sessions")
    .version("1.0.0");
program
    .command("init")
    .description("Initialize project memory in the current git repository")
    .action(async () => {
    try {
        await (0, init_js_1.initProject)(process.cwd());
    }
    catch (err) {
        console.error("Init failed:", err instanceof Error ? err.message : err);
        process.exit(1);
    }
});
program
    .command("ingest-turn")
    .description("Process a completed AI turn and extract memories")
    .requiredOption("--input <file>", "Path to turn JSON file")
    .action(async (opts) => {
    try {
        const raw = fs.readFileSync(opts.input, "utf-8");
        const turn = JSON.parse(raw);
        await (0, index_js_1.ingestTurn)(turn);
        console.log("Turn ingested.");
    }
    catch (err) {
        console.error("Ingest failed:", err instanceof Error ? err.message : err);
        process.exit(1);
    }
});
program
    .command("context")
    .description("Show the current context bundle for this project")
    .action(async () => {
    try {
        const detected = (0, detect_project_js_1.detectProject)(process.cwd());
        if (!detected) {
            console.error("No git repo found.");
            process.exit(1);
        }
        const projectMemoryDir = path.join(detected.repoRoot, ".project-memory");
        const configPath = path.join(projectMemoryDir, "config.json");
        if (!fs.existsSync(configPath)) {
            console.error("Not initialized. Run: project-memory init");
            process.exit(1);
        }
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        const { conn } = (0, db_js_1.getDb)(projectMemoryDir);
        // Use today's session summary if available
        const today = new Date().toISOString().slice(0, 10);
        const sessionId = `${config.projectId}_${today}`;
        const summary = (0, update_summary_js_1.readSummary)(projectMemoryDir, sessionId);
        const bundle = await (0, assemble_context_js_1.assembleContext)(config.projectId, summary, conn);
        console.log((0, assemble_context_js_1.formatContextBundle)(bundle));
    }
    catch (err) {
        console.error("Context failed:", err instanceof Error ? err.message : err);
        process.exit(1);
    }
});
program
    .command("status")
    .description("Show project memory status")
    .action(() => {
    const detected = (0, detect_project_js_1.detectProject)(process.cwd());
    if (!detected) {
        console.log("Not in a git repository.");
        return;
    }
    const projectMemoryDir = path.join(detected.repoRoot, ".project-memory");
    const configPath = path.join(projectMemoryDir, "config.json");
    if (!fs.existsSync(configPath)) {
        console.log("Not initialized. Run: project-memory init");
        return;
    }
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    console.log(`Project: ${config.projectName}`);
    console.log(`ID:      ${config.projectId}`);
    console.log(`Remote:  ${config.remoteUrl}`);
    console.log(`Path:    ${projectMemoryDir}`);
});
program.parse(process.argv);
