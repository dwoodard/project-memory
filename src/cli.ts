#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import { execSync, spawnSync } from "child_process";
import { initProject } from "./init.js";
import { ingestTurn } from "./index.js";
import { assembleContext, formatContextBundle } from "./assemble-context.js";
import { detectProject } from "./detect-project.js";
import { getDb } from "./db.js";
import { queryAll } from "./kuzu-helpers.js";
import {
  readProjectConfig,
  writeProjectConfig,
  PROVIDER_DEFAULTS,
  type ProjectConfig,
} from "./config.js";
import type { Turn } from "./types.js";

const program = new Command();

program
  .name("project-memory")
  .description("Deterministic memory system for AI-assisted coding sessions")
  .version("1.0.0");

program
  .command("init")
  .description("Initialize project memory in the current git repository")
  .action(async () => {
    try {
      await initProject(process.cwd());
    } catch (err) {
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
      const turn: Turn = JSON.parse(raw);
      await ingestTurn(turn);
      console.log("Turn ingested.");
    } catch (err) {
      console.error(
        "Ingest failed:",
        err instanceof Error ? err.message : err
      );
      process.exit(1);
    }
  });

program
  .command("context")
  .description("Show the current context bundle for this project")
  .action(async () => {
    try {
      const detected = detectProject(process.cwd());
      if (!detected) {
        console.error("No git repo found.");
        process.exit(1);
      }

      const projectMemoryDir = path.join(
        detected.repoRoot,
        ".project-memory"
      );
      const configPath = path.join(projectMemoryDir, "config.json");

      if (!fs.existsSync(configPath)) {
        console.error("Not initialized. Run: project-memory init");
        process.exit(1);
      }

      const config: ProjectConfig = JSON.parse(
        fs.readFileSync(configPath, "utf-8")
      );
      const { conn } = getDb(projectMemoryDir);

      // Find the most recently modified session summary
      const summariesDir = path.join(projectMemoryDir, "summaries");
      let summary = "";
      if (fs.existsSync(summariesDir)) {
        const files = fs.readdirSync(summariesDir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => ({ f, mtime: fs.statSync(path.join(summariesDir, f)).mtime }))
          .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
        if (files.length > 0) {
          summary = fs.readFileSync(path.join(summariesDir, files[0].f), "utf-8");
        }
      }

      const bundle = await assembleContext(config.projectId, summary, conn);
      const output = formatContextBundle(bundle);
      console.log(output);
    } catch (err) {
      console.error(
        "Context failed:",
        err instanceof Error ? err.message : err
      );
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show project memory status")
  .action(async () => {
    const detected = detectProject(process.cwd());
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

    const config: ProjectConfig = readProjectConfig(projectMemoryDir);
    console.log(`── Project ──────────────────────────────`);
    console.log(`  Name:      ${config.projectName}`);
    console.log(`  ID:        ${config.projectId}`);
    console.log(`  Remote:    ${config.remoteUrl}`);
    console.log(`  Path:      ${projectMemoryDir}`);
    console.log(`  LLM:       ${config.llm?.provider ?? "not set"} / ${config.llm?.model ?? "not set"}`);
    console.log(`  Embedding: ${config.embedding?.provider ?? "not set"} / ${config.embedding?.model ?? "not set"}`);

    try {
      const { conn } = getDb(projectMemoryDir);

      const pid = config.projectId;
      const kindRows = await queryAll(conn, `MATCH (m:Memory {projectId: '${pid}'}) RETURN m.kind AS kind, count(m) AS cnt`);
      const sessionRows = await queryAll(conn, `MATCH (s:Session {projectId: '${pid}'}) RETURN count(s) AS cnt`);
      const lastRows = await queryAll(conn, `MATCH (m:Memory {projectId: '${pid}'}) RETURN m.createdAt AS t ORDER BY m.createdAt DESC LIMIT 1`);

      const totalMemories = kindRows.reduce((s, r) => s + Number(r["cnt"]), 0);
      const sessionCount = Number(sessionRows[0]?.["cnt"] ?? 0);
      const lastTs = lastRows[0]?.["t"];
      const lastActivity = lastTs ? new Date(String(lastTs)).toLocaleString() : "none";

      console.log(`\n── Memory ───────────────────────────────`);
      console.log(`  Total:     ${totalMemories}`);
      if (kindRows.length > 0) {
        kindRows.forEach((r) => console.log(`  ${String(r["kind"]).padEnd(10)} ${r["cnt"]}`));
      }
      console.log(`\n── Sessions ─────────────────────────────`);
      console.log(`  Count:     ${sessionCount}`);
      console.log(`  Last:      ${lastActivity}`);
    } catch {
      // DB not yet initialized — skip stats
    }
  });

function findOpenPort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(preferred, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on("error", () => {
      // Port taken — let OS assign a free one
      const fallback = net.createServer();
      fallback.listen(0, () => {
        const { port } = fallback.address() as { port: number };
        fallback.close(() => resolve(port));
      });
    });
  });
}

program
  .command("explore")
  .description("Open Kuzu Explorer for this project (requires Docker)")
  .option("-p, --port <port>", "Preferred port (finds next free port if taken)", "8000")
  .action(async () => {
    const opts = program.commands.find((c) => c.name() === "explore")!.opts();
    const preferred = parseInt(opts["port"] ?? "8000", 10);
    const port = await findOpenPort(preferred);

    const detected = detectProject(process.cwd());
    if (!detected) {
      console.error("Not in a git repository.");
      process.exit(1);
    }

    const projectMemoryDir = path.join(detected.repoRoot, ".project-memory");
    const configPath = path.join(projectMemoryDir, "config.json");

    if (!fs.existsSync(configPath)) {
      console.error("Not initialized. Run: project-memory init");
      process.exit(1);
    }

    const graphDir = path.join(projectMemoryDir, "graph");
    if (!fs.existsSync(graphDir)) {
      console.error("No Kuzu database found. Ingest a turn first.");
      process.exit(1);
    }

    const config: ProjectConfig = JSON.parse(
      fs.readFileSync(configPath, "utf-8")
    );

    // Mount graph/ dir — explorer defaults to KUZU_DIR=/database, KUZU_FILE=database.kz
    const cmd = [
      "docker run",
      `--name kuzu-explorer-${config.projectId}`,
      "--rm",
      `-p ${port}:8000`,
      `-v "${graphDir}:/database"`,
      "-e MODE=READ_WRITE",
      "kuzudb/explorer:latest",
    ].join(" ");

    console.log(`Opening Kuzu Explorer for: ${config.projectName}`);
    console.log(`Database: ${graphDir}`);
    console.log(`URL:      http://localhost:${port}`);
    console.log("");
    console.log(`Running: ${cmd}`);
    console.log("Press Ctrl+C to stop.\n");

    try {
      execSync(cmd, { stdio: "inherit" });
    } catch {
      // User Ctrl+C'd — normal exit
    }
  });

program
  .command("config")
  .description("View or interactively set LLM configuration")
  .option("--set <key=value>", "Set a config value directly (e.g. llm.provider=ollama)")
  .action(async (opts) => {
    const { select, input } = await import("@inquirer/prompts");

    const detected = detectProject(process.cwd());
    if (!detected) {
      console.error("Not in a git repository.");
      process.exit(1);
    }
    const projectMemoryDir = path.join(detected.repoRoot, ".project-memory");
    const configPath = path.join(projectMemoryDir, "config.json");
    if (!fs.existsSync(configPath)) {
      console.error("Not initialized. Run: project-memory init");
      process.exit(1);
    }
    const config = readProjectConfig(projectMemoryDir);

    if (opts.set) {
      const [key, value] = opts.set.split("=");
      if (!key || value === undefined) {
        console.error("Usage: --set llm.provider=ollama");
        process.exit(1);
      }
      const parts = key.split(".");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let obj: any = config;
      for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
      obj[parts[parts.length - 1]] = value;
      writeProjectConfig(projectMemoryDir, config);
      console.log(`Set ${key} = ${value}`);
      return;
    }

    // Interactive mode
    console.log("\nCurrent config:");
    console.log(`  LLM:       ${config.llm?.provider ?? "not set"} / ${config.llm?.model ?? "not set"}`);
    console.log(`  Embedding: ${config.embedding?.provider ?? "not set"} / ${config.embedding?.model ?? "not set"}\n`);

    const providerChoices = [
      { name: "LM Studio  (local, free)", value: "lmstudio" },
      { name: "Ollama     (local, free)", value: "ollama" },
      { name: "OpenAI     (paid)", value: "openai" },
      { name: "Anthropic  (paid)", value: "anthropic" },
    ] as const;

    async function fetchModels(baseUrl: string): Promise<{ id: string }[]> {
      const base = baseUrl.replace(/\/+$/, "");
      const url = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
      const res = await fetch(url);
      const json = await res.json() as { data?: { id: string }[] };
      return json.data ?? [];
    }

    async function pickModel(
      label: string,
      baseUrl: string,
      isLocal: boolean,
      currentModel: string,
      filterFn?: (id: string) => boolean
    ): Promise<string> {
      if (!isLocal) return input({ message: `${label} model name:`, default: currentModel });
      process.stdout.write(`Fetching ${label.toLowerCase()} models...`);
      try {
        const all = await fetchModels(baseUrl);
        const filtered = filterFn ? all.filter((m) => filterFn(m.id)) : all;
        process.stdout.write("\r\x1b[K");
        if (filtered.length === 0) {
          console.log(`  No ${label.toLowerCase()} models found, enter manually.`);
          return input({ message: `${label} model name:`, default: currentModel });
        }
        return select({
          message: `Select ${label.toLowerCase()} model:`,
          choices: filtered.map((m) => ({ name: m.id, value: m.id })),
          default: filtered.find((m) => m.id === currentModel)?.id ?? filtered[0].id,
        });
      } catch {
        process.stdout.write("\r\x1b[K");
        console.log(`  Could not reach ${baseUrl}, enter manually.`);
        return input({ message: `${label} model name:`, default: currentModel });
      }
    }

    // --- LLM ---
    console.log("── LLM (used for memory extraction) ────");
    const llmProvider = await select({ message: "LLM provider:", choices: providerChoices, default: config.llm.provider });
    const llmDefaults = PROVIDER_DEFAULTS[llmProvider];
    const llmBaseUrl = await input({ message: "LLM base URL:", default: llmDefaults.baseUrl ?? config.llm.baseUrl });
    const isLlmLocal = llmProvider === "lmstudio" || llmProvider === "ollama";
    const llmModel = await pickModel("LLM", llmBaseUrl, isLlmLocal, llmDefaults.model ?? config.llm.model, (id) => !id.includes("embed"));
    let llmApiKey = config.llm.apiKey;
    if (!isLlmLocal) llmApiKey = await input({ message: "LLM API Key:", default: config.llm.apiKey || "" });

    // --- Embedding ---
    console.log("\n── Embedding (used for vector search) ──");
    const embProvider = await select({ message: "Embedding provider:", choices: providerChoices, default: config.embedding.provider });
    const embDefaults = PROVIDER_DEFAULTS[embProvider];
    const embBaseUrl = await input({ message: "Embedding base URL:", default: embDefaults.baseUrl ?? config.embedding.baseUrl });
    const isEmbLocal = embProvider === "lmstudio" || embProvider === "ollama";
    const embModel = await pickModel("Embedding", embBaseUrl, isEmbLocal, embDefaults.model ?? config.embedding.model, (id) => id.includes("embed"));
    let embApiKey = config.embedding.apiKey;
    if (!isEmbLocal) embApiKey = await input({ message: "Embedding API Key:", default: config.embedding.apiKey || "" });

    config.llm = { provider: llmProvider, model: llmModel, baseUrl: llmBaseUrl, apiKey: llmApiKey };
    config.embedding = { provider: embProvider, model: embModel, baseUrl: embBaseUrl, apiKey: embApiKey };
    writeProjectConfig(projectMemoryDir, config);

    console.log(`\nSaved to .project-memory/config.json`);
    console.log(`  LLM:       ${llmProvider} / ${llmModel}`);
    console.log(`  Embedding: ${embProvider} / ${embModel}`);
  });

const HOOK_SCRIPTS: Record<string, string> = {
  "stop":           "hook.js",
  "user-prompt":    "hook-user-prompt.js",
  "compact":        "hook-compact.js",
  "post-tool-use":  "hook-post-tool-use.js",
  "session-start":  "hook-session-start.js",
};

program
  .command("hook <type>")
  .description("Run a Claude Code hook (reads JSON payload from stdin)")
  .action((type: string) => {
    const script = HOOK_SCRIPTS[type];
    if (!script) {
      console.error(`Unknown hook type: ${type}`);
      console.error(`Valid types: ${Object.keys(HOOK_SCRIPTS).join(", ")}`);
      process.exit(1);
    }
    const scriptPath = path.join(__dirname, script);
    const result = spawnSync(process.execPath, [scriptPath], { stdio: "inherit" });
    process.exit(result.status ?? 0);
  });

program.parse(process.argv);
