#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import * as net from "net";
import { execSync, spawnSync } from "child_process";
import { initProject } from "./init.js";
import { ingestTurn } from "./index.js";
import { assembleContext, formatContextBundle } from "./assemble-context.js";
import { detectProject } from "./detect-project.js";
import { getDb, applySchema } from "./db.js";
import { queryAll } from "./kuzu-helpers.js";
import {
  readProjectConfig,
  writeProjectConfig,
  PROVIDER_DEFAULTS,
  type ProjectConfig,
} from "./config.js";
import { embed, llmChatMessages } from "./llm.js";
import type { ChatMessage, ToolDefinition } from "./llm.js";
import { searchAll, searchMemoriesWithGraph } from "./search.js";
import type { Turn } from "./types.js";

const cerr = (msg: string) => console.error(chalk.red(msg));

async function runConfigPrompt(projectMemoryDir: string): Promise<void> {
  const { select, input } = await import("@inquirer/prompts");
  const config = readProjectConfig(projectMemoryDir);

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

  console.log(chalk.bold.cyan("── LLM (used for memory extraction) ────"));
  const llmProvider = await select({ message: "LLM provider:", choices: providerChoices, default: config.llm.provider });
  const llmDefaults = PROVIDER_DEFAULTS[llmProvider];
  const llmBaseUrl = await input({ message: "LLM base URL:", default: llmDefaults.baseUrl ?? config.llm.baseUrl });
  const isLlmLocal = llmProvider === "lmstudio" || llmProvider === "ollama";
  const llmModel = await pickModel("LLM", llmBaseUrl, isLlmLocal, llmDefaults.model ?? config.llm.model, (id) => !id.includes("embed"));
  let llmApiKey = config.llm.apiKey;
  if (!isLlmLocal) llmApiKey = await input({ message: "LLM API Key:", default: config.llm.apiKey || "" });

  console.log(chalk.bold.cyan("\n── Embedding (used for vector search) ──"));
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

  console.log(`\n${chalk.green("Saved to")} ${chalk.dim(".pensive/config.json")}`);
  console.log(`  LLM:       ${chalk.white(llmProvider)} / ${chalk.dim(llmModel)}`);
  console.log(`  Embedding: ${chalk.white(embProvider)} / ${chalk.dim(embModel)}`);
}

const program = new Command();

program
  .name("pensive")
  .description("Deterministic memory system for AI-assisted coding sessions")
  .version("1.0.0");

program
  .command("init")
  .description("Initialize project memory in the current directory")
  .action(async () => {
    try {
      const freshInit = await initProject(process.cwd());
      if (freshInit) {
        // Offer to configure LLM right after a fresh init
        const { confirm } = await import("@inquirer/prompts");
        const doConfig = await confirm({ message: "Configure LLM and embedding models now?", default: true });
        if (doConfig) {
          const detected = detectProject(process.cwd());
          if (detected) {
            const projectMemoryDir = path.join(detected.projectRoot, ".pensive");
            await runConfigPrompt(projectMemoryDir);
          }
        }
      }
    } catch (err) {
      console.error(chalk.red("Init failed:"), err instanceof Error ? err.message : err);
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
      console.log(chalk.green("Turn ingested."));
    } catch (err) {
      console.error(chalk.red("Ingest failed:"), err instanceof Error ? err.message : err);
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
        cerr("No pensive project found. Run: pensive init");
        process.exit(1);
      }

      const projectMemoryDir = path.join(
        detected.projectRoot,
        ".pensive"
      );
      const configPath = path.join(projectMemoryDir, "config.json");

      if (!fs.existsSync(configPath)) {
        cerr("Not initialized. Run: pensive init");
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
      console.error(chalk.red("Context failed:"), err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show project memory status")
  .action(async () => {
    const detected = detectProject(process.cwd());
    if (!detected) {
      console.log("No pensive project found. Run: pensive init");
      return;
    }

    const projectMemoryDir = path.join(detected.projectRoot, ".pensive");
    const configPath = path.join(projectMemoryDir, "config.json");

    if (!fs.existsSync(configPath)) {
      console.log("Not initialized. Run: pensive init");
      return;
    }

    const config: ProjectConfig = readProjectConfig(projectMemoryDir);
    console.log(chalk.bold.cyan(`── Project ──────────────────────────────`));
    console.log(`  Name:      ${chalk.white(config.projectName)}`);
    console.log(`  ID:        ${chalk.dim(config.projectId)}`);
    if (config.remoteUrl) console.log(`  Remote:    ${chalk.dim(config.remoteUrl)}`);
    console.log(`  Path:      ${chalk.dim(projectMemoryDir)}`);
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

      console.log(chalk.bold.cyan(`\n── Memory ───────────────────────────────`));
      console.log(`  Total:     ${chalk.white(String(totalMemories))}`);
      if (kindRows.length > 0) {
        kindRows.forEach((r) => console.log(`  ${String(r["kind"]).padEnd(10)} ${chalk.dim(String(r["cnt"]))}`));
      }
      console.log(chalk.bold.cyan(`\n── Sessions ─────────────────────────────`));
      console.log(`  Count:     ${chalk.white(String(sessionCount))}`);
      console.log(`  Last:      ${chalk.dim(lastActivity)}`);
    } catch {
      // DB not yet initialized — skip stats
    }
  });

program
  .command("search <query>")
  .description("Semantic search across memories, tasks, and sessions")
  .option("-k, --top <n>", "Number of results", "10")
  .action(async (query: string, opts) => {
    const detected = detectProject(process.cwd());
    if (!detected) { cerr("No pensive project found. Run: pensive init"); process.exit(1); }

    const projectMemoryDir = path.join(detected.projectRoot, ".pensive");
    const config = readProjectConfig(projectMemoryDir);
    const { conn } = getDb(projectMemoryDir);
    await applySchema(conn);

    const topK = parseInt(opts.top ?? "5", 10);
    const results = await searchAll(conn, config.projectId, query, topK);

    if (results.length === 0) {
      console.log(chalk.dim("No results found."));
      return;
    }

    console.log(`\n${chalk.dim("Query:")} "${chalk.white(query)}"\n`);

    for (const r of results) {
      if (r.nodeType === "memory") {
        console.log(`${chalk.bold.cyan("──")} ${chalk.bold("[" + (r.kind ?? "memory").toUpperCase() + "]")} ${chalk.white(r.title)}  ${chalk.dim("(score: " + r.score.toFixed(4) + ")")}`);
        if (r.summary) console.log(`   ${chalk.dim(r.summary)}`);
        if (r.sessionId) {
          const sessRows = await queryAll(conn,
            `MATCH (s:Session)-[:HAS_MEMORY]->(m:Memory {id: '${r.id}'})
             RETURN s.title AS title`
          );
          if (sessRows.length > 0) console.log(`   ${chalk.dim("session:")} ${sessRows[0]["title"] ?? ""}`);
        }
      } else if (r.nodeType === "task") {
        const statusColor = r.status === "active" ? chalk.green : r.status === "blocked" ? chalk.yellow : r.status === "done" ? chalk.dim : chalk.white;
        console.log(`${chalk.bold.cyan("──")} ${chalk.bold("[TASK]")} ${chalk.white(r.title)}  ${statusColor(r.status ?? "")}  ${chalk.dim("(score: " + r.score.toFixed(4) + ")")}`);
        if (r.summary) console.log(`   ${chalk.dim(r.summary)}`);
      } else {
        console.log(`${chalk.bold.cyan("──")} ${chalk.bold("[SESSION]")} ${chalk.white(r.title)}  ${chalk.dim("(score: " + r.score.toFixed(4) + ")")}`);
        if (r.summary) console.log(`   ${chalk.dim(r.summary.slice(0, 120) + (r.summary.length > 120 ? "…" : ""))}`);
      }
      console.log();
    }
  });

program
  .command("backfill-embeddings")
  .description("Generate and store embeddings for all nodes missing them (Memory, Task, Session)")
  .action(async () => {
    const detected = detectProject(process.cwd());
    if (!detected) { cerr("No pensive project found. Run: pensive init"); process.exit(1); }

    const projectMemoryDir = path.join(detected.projectRoot, ".pensive");
    const config = readProjectConfig(projectMemoryDir);
    const { conn } = getDb(projectMemoryDir);
    await applySchema(conn);
    const pid = config.projectId;

    type BackfillRow = { id: string; text: string; setQuery: (id: string, literal: string) => string };

    const memRows = (await queryAll(conn,
      `MATCH (m:Memory {projectId: '${pid}'}) WHERE m.embedding IS NULL OR size(m.embedding) = 0
       RETURN m.id AS id, m.title AS title, m.summary AS summary`
    )).map((r): BackfillRow => ({
      id: String(r["id"]),
      text: `${r["title"]}. ${r["summary"]}`,
      setQuery: (id, lit) => `MATCH (m:Memory {id: '${id}'}) SET m.embedding = ${lit}`,
    }));

    const taskRows = (await queryAll(conn,
      `MATCH (t:Task {projectId: '${pid}'}) WHERE t.embedding IS NULL OR size(t.embedding) = 0
       RETURN t.id AS id, t.title AS title, t.summary AS summary`
    )).map((r): BackfillRow => ({
      id: String(r["id"]),
      text: `${r["title"]}. ${r["summary"]}`,
      setQuery: (id, lit) => `MATCH (t:Task {id: '${id}'}) SET t.embedding = ${lit}`,
    }));

    const sessionRows = (await queryAll(conn,
      `MATCH (s:Session {projectId: '${pid}'}) WHERE s.embedding IS NULL OR size(s.embedding) = 0
       RETURN s.id AS id, s.title AS title, s.summary AS summary`
    )).map((r): BackfillRow => ({
      id: String(r["id"]),
      text: `${r["title"]}. ${r["summary"]}`,
      setQuery: (id, lit) => `MATCH (s:Session {id: '${id}'}) SET s.embedding = ${lit}`,
    }));

    const rows = [...memRows, ...taskRows, ...sessionRows];

    if (rows.length === 0) {
      console.log(chalk.dim("All nodes already have embeddings."));
      return;
    }

    console.log(chalk.cyan(`Backfilling ${rows.length} node(s) (${memRows.length} memories, ${taskRows.length} tasks, ${sessionRows.length} sessions)...`));
    let done = 0, failed = 0;

    for (const row of rows) {
      try {
        const embedding = await embed(row.text);
        const literal = `[${embedding.join(", ")}]`;
        await conn.query(row.setQuery(row.id, literal));
        done++;
        process.stdout.write(`\r  ${done}/${rows.length} embedded, ${failed} failed`);
      } catch {
        failed++;
        process.stdout.write(`\r  ${done}/${rows.length} embedded, ${failed} failed`);
      }
    }

    console.log(`\n${chalk.green("Done.")} ${done} embedded${failed > 0 ? chalk.red(`, ${failed} failed`) : ""}.`);
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
      cerr("No pensive project found. Run: pensive init");
      process.exit(1);
    }

    const projectMemoryDir = path.join(detected.projectRoot, ".pensive");
    const configPath = path.join(projectMemoryDir, "config.json");

    if (!fs.existsSync(configPath)) {
      cerr("Not initialized. Run: pensive init");
      process.exit(1);
    }

    const graphDir = path.join(projectMemoryDir, "graph");
    if (!fs.existsSync(graphDir)) {
      cerr("No Kuzu database found. Ingest a turn first.");
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

    console.log(`${chalk.bold("Opening Kuzu Explorer for:")} ${chalk.white(config.projectName)}`);
    console.log(`${chalk.dim("Database:")} ${chalk.dim(graphDir)}`);
    console.log(`${chalk.dim("URL:")}      ${chalk.cyan(`http://localhost:${port}`)}`);
    console.log("");
    console.log(chalk.dim(`Running: ${cmd}`));
    console.log(chalk.dim("Press Ctrl+C to stop.\n"));

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
    const detected = detectProject(process.cwd());
    if (!detected) {
      cerr("No pensive project found. Run: pensive init");
      process.exit(1);
    }
    const projectMemoryDir = path.join(detected.projectRoot, ".pensive");
    const configPath = path.join(projectMemoryDir, "config.json");
    if (!fs.existsSync(configPath)) {
      cerr("Not initialized. Run: pensive init");
      process.exit(1);
    }
    const config = readProjectConfig(projectMemoryDir);

    if (opts.set) {
      const [key, value] = opts.set.split("=");
      if (!key || value === undefined) {
        cerr("Usage: --set llm.provider=ollama");
        process.exit(1);
      }
      const parts = key.split(".");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let obj: any = config;
      for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
      obj[parts[parts.length - 1]] = value;
      writeProjectConfig(projectMemoryDir, config);
      console.log(`${chalk.green("Set")} ${chalk.white(key)} = ${value}`);
      return;
    }

    // Interactive mode
    console.log(chalk.bold("\nCurrent config:"));
    console.log(`  LLM:       ${chalk.white(config.llm?.provider ?? "not set")} / ${chalk.dim(config.llm?.model ?? "not set")}`);
    console.log(`  Embedding: ${chalk.white(config.embedding?.provider ?? "not set")} / ${chalk.dim(config.embedding?.model ?? "not set")}\n`);
    await runConfigPrompt(projectMemoryDir);
  });

// ── Project ──────────────────────────────────────────────────────────────────

const projectCmd = program
  .command("project")
  .description("View or update this project's description");

projectCmd
  .action(async () => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;

    const rows = await queryAll(conn, `MATCH (p:Project {id: '${pid}'}) RETURN p`);
    const p = rows[0]?.["p"] as Record<string, unknown> | undefined;

    console.log(`\n${chalk.bold.cyan("── Project ──────────────────────────────")}`);
    console.log(`  Name:    ${chalk.white(config.projectName)}`);
    console.log(`  ID:      ${chalk.dim(pid)}`);
    if (config.remoteUrl) console.log(`  Remote:  ${chalk.dim(config.remoteUrl)}`);
    console.log(`  Path:    ${chalk.dim(config.repoPath)}`);

    const description = p?.["description"] ? String(p["description"]) : "";
    if (description) {
      console.log(`\n${chalk.bold.cyan("── Description ──────────────────────────")}`);
      console.log(description);
    } else {
      console.log(chalk.dim("\n  No description yet. Set one with: pensive project set description \"...\""));
    }
    console.log("");
  });

projectCmd
  .command("set <field> <value>")
  .description("Set a project field: name, remoteUrl, description")
  .action(async (field: string, value: string) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const { escape: esc } = await import("./kuzu-helpers.js");
    const pid = config.projectId;

    const allowed = ["name", "remoteUrl", "description"];
    if (!allowed.includes(field)) {
      cerr(`Unknown field "${field}". Allowed: ${allowed.join(", ")}`);
      process.exit(1);
    }

    await conn.query(
      `MATCH (p:Project {id: '${esc(pid)}'}) SET p.${field} = '${esc(value)}'`
    );

    // Keep config.json in sync for name/remoteUrl
    if (field === "name") {
      config.projectName = value;
      writeProjectConfig(path.join(detectProject(process.cwd())!.projectRoot, ".pensive"), config);
    } else if (field === "remoteUrl") {
      config.remoteUrl = value;
      writeProjectConfig(path.join(detectProject(process.cwd())!.projectRoot, ".pensive"), config);
    }

    console.log(`${chalk.green("Set")} ${chalk.white(field)}: ${value}`);
  });

// ── Tasks ────────────────────────────────────────────────────────────────────

async function getProjectDb(cwd: string) {
  const detected = detectProject(cwd);
  if (!detected) {
    cerr("No pensive project found. Run: pensive init");
    process.exit(1);
  }
  const projectMemoryDir = path.join(detected.projectRoot, ".pensive");
  const configPath = path.join(projectMemoryDir, "config.json");
  if (!fs.existsSync(configPath)) {
    cerr("Not initialized. Run: pensive init");
    process.exit(1);
  }
  const config = readProjectConfig(projectMemoryDir);
  const { conn } = getDb(projectMemoryDir);
  await applySchema(conn); // runs migrations; all statements are idempotent
  return { config, conn, projectMemoryDir };
}

function shortId(id: string): string {
  return id.replace(/^(mem_|task_)/, "").slice(0, 6);
}

function sessionShortId(id: string): string {
  // Strip well-known Claude Code session type prefixes (e.g. "manual_")
  const stripped = id.replace(/^[a-z]+_/, "");
  // If nothing was stripped (already a UUID etc.), use the raw id
  const base = stripped.length > 0 && stripped !== id ? stripped : id;
  return base.slice(0, 8);
}

function printSubtasks(parentId: string, subtasks: Record<string, unknown>[], indent: string): void {
  const children = subtasks.filter((s) => String(s["parentId"]) === parentId);
  children.forEach((s) => {
    const status = String(s["status"]);
    const checkbox = status === "done" ? chalk.dim("[x]") : status === "blocked" ? chalk.yellow("[-]") : "[ ]";
    const titleFmt = status === "done" ? chalk.dim(String(s["title"])) : status === "blocked" ? chalk.yellow(String(s["title"])) : String(s["title"]);
    console.log(`${indent}${checkbox} ${chalk.dim("[" + shortId(String(s["id"])) + "]")}  ${titleFmt}`);
    const subSummary = String(s["summary"] ?? "").trim();
    if (subSummary) {
      subSummary.split("\n").forEach((line) =>
        console.log(`${indent}    ${chalk.dim("- " + line)}`)
      );
    }
  });
}

function printTaskWithDetails(
  t: Record<string, unknown>,
  titleLine: string,
  subtasks: Record<string, unknown>[],
  summaryIndent: string,
  subtaskIndent: string
): void {
  console.log(titleLine);
  const summary = String(t["summary"] ?? "").trim();
  if (summary) {
    summary.split("\n").forEach((line) =>
      console.log(`${summaryIndent}${chalk.dim("- " + line)}`)
    );
  }
  printSubtasks(String(t["id"]), subtasks, subtaskIndent);
}

function printTaskList(
  active: Record<string, unknown> | undefined,
  pending: Record<string, unknown>[],
  blocked: Record<string, unknown>[],
  done: Record<string, unknown>[],
  subtasks: Record<string, unknown>[] = []
): void {
  if (!active && pending.length === 0 && blocked.length === 0 && done.length === 0) {
    console.log("No tasks. Add one: pensive tasks add \"title\"");
    return;
  }

  if (active) {
    printTaskWithDetails(
      active,
      `\n${chalk.green("●")} ${chalk.bold.green("ACTIVE")} ${chalk.dim("[" + shortId(String(active["id"])) + "]")}   ${chalk.bold.green(String(active["title"]))}`,
      subtasks,
      "                      ",
      "       "
    );
  } else {
    console.log(chalk.dim("\n  (no active task)"));
  }

  if (pending.length > 0) {
    console.log(chalk.bold("\n  QUEUE"));
    pending.forEach((t, i) => {
      printTaskWithDetails(
        t,
        `  ${chalk.dim(String(i + 1).padStart(2))}  ${chalk.dim("[" + shortId(String(t["id"])) + "]")}  ${t["title"]}`,
        subtasks,
        "        ",
        "        "
      );
    });
  }

  if (blocked.length > 0) {
    console.log(chalk.bold.yellow("\n  BLOCKED"));
    blocked.forEach((t) => {
      printTaskWithDetails(
        t,
        `  ${chalk.yellow("✗")}  ${chalk.dim("[" + shortId(String(t["id"])) + "]")}  ${chalk.yellow(String(t["title"]))}`,
        subtasks,
        "        ",
        "        "
      );
    });
  }

  if (done.length > 0) {
    console.log(chalk.dim("\n  DONE"));
    done.forEach((t) => console.log(chalk.dim(`  ✓  ${t["title"]}`)));
  }

  console.log("");
}

const tasksCmd = program
  .command("tasks")
  .description("Manage project tasks");

// Default action: list all tasks
tasksCmd
  .option("--done", "Include completed tasks in the output")
  .action(async () => {
    const opts = tasksCmd.opts();
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;

    const activeRows = await queryAll(conn,
      `MATCH (m:Task {projectId: '${pid}', status: 'active'})
       WHERE m.parentId = '' OR m.parentId IS NULL
       RETURN m ORDER BY m.createdAt DESC LIMIT 1`);
    const pendingRows = await queryAll(conn,
      `MATCH (m:Task {projectId: '${pid}', status: 'pending'})
       WHERE m.parentId = '' OR m.parentId IS NULL
       RETURN m ORDER BY m.taskOrder ASC`);
    const blockedRows = await queryAll(conn,
      `MATCH (m:Task {projectId: '${pid}', status: 'blocked'})
       WHERE m.parentId = '' OR m.parentId IS NULL
       RETURN m ORDER BY m.createdAt DESC`);

    const doneRows = opts.done ? await queryAll(conn,
      `MATCH (m:Task {projectId: '${pid}', status: 'done'})
       WHERE m.parentId = '' OR m.parentId IS NULL
       RETURN m ORDER BY m.createdAt DESC`) : [];
    const subtaskRows = await queryAll(conn,
      `MATCH (t:Task {projectId: '${pid}'}) WHERE t.parentId <> '' RETURN t`);

    printTaskList(
      activeRows[0]?.["m"] as Record<string, unknown> | undefined,
      pendingRows.map((r) => r["m"] as Record<string, unknown>),
      blockedRows.map((r) => r["m"] as Record<string, unknown>),
      doneRows.map((r) => r["m"] as Record<string, unknown>),
      subtaskRows.map((r) => r["t"] as Record<string, unknown>)
    );
  });

tasksCmd
  .command("add <title>")
  .description("Add a task to the queue")
  .option("--parent <target>", "Parent task id prefix, queue position, or 'active'")
  .action(async (title: string, opts: { parent?: string }) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;
    const { escape: esc } = await import("./kuzu-helpers.js");
    const { default: crypto } = await import("crypto");

    let parentId = "";
    if (opts.parent) {
      const allRows = await queryAll(conn,
        `MATCH (t:Task {projectId: '${pid}'}) WHERE t.status <> 'done' RETURN t ORDER BY t.taskOrder ASC`);
      const all = allRows.map((r) => r["t"] as Record<string, unknown>);
      const pos = /^\d+$/.test(opts.parent) ? parseInt(opts.parent, 10) : NaN;
      let parentTask: Record<string, unknown> | undefined;
      if (opts.parent === "active") {
        parentTask = all.find((t) => t["status"] === "active");
      } else if (!isNaN(pos) && pos >= 1 && pos <= all.length) {
        parentTask = all[pos - 1];
      } else {
        parentTask = all.find((t) => shortId(String(t["id"])).startsWith(opts.parent!));
      }
      if (!parentTask) {
        cerr(`No task matching "${opts.parent}". Run: pensive tasks`);
        process.exit(1);
      }
      parentId = String(parentTask["id"]);
    }

    const orderRows = await queryAll(conn,
      `MATCH (m:Task {projectId: '${pid}', status: 'pending'})
       RETURN max(m.taskOrder) AS maxOrder`);
    const maxOrder = Number(orderRows[0]?.["maxOrder"] ?? 0);
    const taskOrder = maxOrder + 1;

    const id = `task_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

    await conn.query(
      `CREATE (t:Task {
        id: '${esc(id)}',
        title: '${esc(title)}',
        summary: '',
        status: 'pending',
        taskOrder: ${taskOrder},
        projectId: '${esc(pid)}',
        createdAt: '${new Date().toISOString()}',
        parentId: '${esc(parentId)}'
      })`
    );

    await conn.query(
      `MATCH (p:Project {id: '${esc(pid)}'}), (t:Task {id: '${esc(id)}'})
       CREATE (p)-[:HAS_TASK]->(t)`
    );

    // Best-effort embedding
    embed(title).then((vec) => {
      const literal = `[${vec.join(", ")}]`;
      conn.query(`MATCH (t:Task {id: '${esc(id)}'}) SET t.embedding = ${literal}`).catch(() => {});
    }).catch(() => {});

    if (parentId) {
      const parentRows = await queryAll(conn, `MATCH (t:Task {id: '${esc(parentId)}'}) RETURN t`);
      const parentTitle = (parentRows[0]?.["t"] as Record<string, unknown>)?.["title"] ?? parentId;
      console.log(`${chalk.green("Added:")} ${title}  ${chalk.dim("[" + shortId(id) + "]")}  ${chalk.dim("↳ " + parentTitle)}`);
    } else {
      console.log(`${chalk.green("Added:")} ${title}  ${chalk.dim("[" + shortId(id) + "]")}`);
    }
  });

tasksCmd
  .command("summary <target> <text>")
  .description("Set the summary/details for a task by queue position or id prefix")
  .action(async (target: string, text: string) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;
    const { escape: esc } = await import("./kuzu-helpers.js");

    const allRows = await queryAll(conn,
      `MATCH (t:Task {projectId: '${pid}'}) WHERE t.status <> 'done' RETURN t ORDER BY t.taskOrder ASC`);
    const all = allRows.map((r) => r["t"] as Record<string, unknown>);

    let targetId: string | undefined;
    if (target === "active") {
      targetId = String(all.find((t) => t["status"] === "active")?.[  "id"] ?? "");
    } else {
      const pos = /^\d+$/.test(target) ? parseInt(target, 10) : NaN;
      if (!isNaN(pos) && pos >= 1 && pos <= all.length) {
        targetId = String(all[pos - 1]["id"]);
      } else {
        targetId = String(all.find((t) => shortId(String(t["id"])).startsWith(target))?.[  "id"] ?? "");
      }
    }

    if (!targetId) {
      cerr(`No task matching "${target}". Run: pensive tasks`);
      process.exit(1);
    }

    await conn.query(`MATCH (t:Task {id: '${esc(targetId)}'}) SET t.summary = '${esc(text)}'`);
    const task = all.find((t) => String(t["id"]) === targetId);
    const embedText = `${task?.["title"] ?? ""}. ${text}`;
    embed(embedText).then((vec) => {
      const literal = `[${vec.join(", ")}]`;
      conn.query(`MATCH (t:Task {id: '${esc(targetId)}'}) SET t.embedding = ${literal}`).catch(() => {});
    }).catch(() => {});
    console.log(`${chalk.green("Summary set:")} ${task?.["title"]}  ${chalk.dim("- " + text)}`);
  });

tasksCmd
  .command("update <target> <text>")
  .description("Update a task's title by queue position or id prefix")
  .action(async (target: string, text: string) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;
    const { escape: esc } = await import("./kuzu-helpers.js");

    const allRows = await queryAll(conn,
      `MATCH (t:Task {projectId: '${pid}'})
       WHERE t.status <> 'done'
       RETURN t ORDER BY t.taskOrder ASC`);
    const all = allRows.map((r) => r["t"] as Record<string, unknown>);

    let targetId: string | undefined;
    const pos = /^\d+$/.test(target) ? parseInt(target, 10) : NaN;
    if (!isNaN(pos) && pos >= 1 && pos <= all.length) {
      targetId = String(all[pos - 1]["id"]);
    } else {
      const match = all.find((t) => shortId(String(t["id"])).startsWith(target));
      targetId = match ? String(match["id"]) : undefined;
    }

    if (!targetId) {
      cerr(`No task matching "${target}". Run: pensive tasks`);
      process.exit(1);
    }

    await conn.query(`MATCH (t:Task {id: '${esc(targetId)}'}) SET t.title = '${esc(text)}'`);
    embed(text).then((vec) => {
      const literal = `[${vec.join(", ")}]`;
      conn.query(`MATCH (t:Task {id: '${esc(targetId)}'}) SET t.embedding = ${literal}`).catch(() => {});
    }).catch(() => {});
    console.log(`${chalk.green("Updated:")} ${text}  ${chalk.dim("[" + shortId(targetId) + "]")}`);
  });

tasksCmd
  .command("start <target>")
  .description("Set a queued task active (by queue position or id prefix)")
  .action(async (target: string) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;
    const { escape: esc } = await import("./kuzu-helpers.js");

    const pendingRows = await queryAll(conn,
      `MATCH (m:Task {projectId: '${pid}', status: 'pending'})
       RETURN m ORDER BY m.taskOrder ASC`);
    const pending = pendingRows.map((r) => r["m"] as Record<string, unknown>);

    let target_id: string | undefined;
    const pos = /^\d+$/.test(target) ? parseInt(target, 10) : NaN;
    if (!isNaN(pos) && pos >= 1 && pos <= pending.length) {
      target_id = String(pending[pos - 1]["id"]);
    } else {
      const match = pending.find((t) => shortId(String(t["id"])).startsWith(target));
      target_id = match ? String(match["id"]) : undefined;
    }

    if (!target_id) {
      cerr(`No pending task matching "${target}". Run: pensive tasks`);
      process.exit(1);
    }

    // Demote any currently active task — push it to front of queue
    const minOrderRows = await queryAll(conn,
      `MATCH (m:Task {projectId: '${esc(pid)}', status: 'pending'})
       RETURN min(m.taskOrder) AS minOrder`);
    const minOrder = Number(minOrderRows[0]?.["minOrder"] ?? 1);
    await conn.query(
      `MATCH (m:Task {projectId: '${esc(pid)}', status: 'active'})
       SET m.status = 'pending', m.taskOrder = ${minOrder - 1}`
    );
    await conn.query(
      `MATCH (m:Task {id: '${esc(target_id)}'}) SET m.status = 'active'`
    );

    const title = pending.find((t) => String(t["id"]) === target_id)?.["title"];
    console.log(`${chalk.green("Active:")} ${title}`);
  });

tasksCmd
  .command("done [targets...]")
  .description("Mark tasks as done — active task if no args, or by id prefix/queue position")
  .action(async (targets: string[]) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;
    const { escape: esc } = await import("./kuzu-helpers.js");

    if (targets.length === 0) {
      const rows = await queryAll(conn,
        `MATCH (m:Task {projectId: '${pid}', status: 'active'})
         RETURN m LIMIT 1`);
      if (rows.length === 0) { console.log(chalk.dim("No active task.")); return; }
      const task = rows[0]["m"] as Record<string, unknown>;
      await conn.query(`MATCH (m:Task {id: '${esc(String(task["id"]))}' }) SET m.status = 'done'`);
      console.log(`${chalk.green("Done:")} ${task["title"]}`);
      return;
    }

    const allRows = await queryAll(conn,
      `MATCH (m:Task {projectId: '${pid}'}) WHERE m.status <> 'done'
       RETURN m ORDER BY m.taskOrder ASC`);
    const all = allRows.map((r) => r["m"] as Record<string, unknown>);
    const pending = all.filter((t) => t["status"] === "pending");

    for (const target of targets) {
      let task: Record<string, unknown> | undefined;
      const pos = /^\d+$/.test(target) ? parseInt(target, 10) : NaN;
      if (!isNaN(pos) && pos >= 1 && pos <= pending.length) {
        task = pending[pos - 1];
      } else {
        task = all.find((t) => shortId(String(t["id"])).startsWith(target));
      }
      if (!task) { cerr(`No task matching "${target}"`); continue; }
      await conn.query(`MATCH (m:Task {id: '${esc(String(task["id"]))}' }) SET m.status = 'done'`);
      console.log(`${chalk.green("Done:")} ${task["title"]}`);
    }
  });

tasksCmd
  .command("block <reason>")
  .description("Mark the active task as blocked")
  .action(async (reason: string) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;

    const rows = await queryAll(conn,
      `MATCH (m:Task {projectId: '${pid}', status: 'active'})
       RETURN m LIMIT 1`);
    if (rows.length === 0) {
      console.log(chalk.dim("No active task."));
      return;
    }

    const { escape: esc } = await import("./kuzu-helpers.js");
    const task = rows[0]["m"] as Record<string, unknown>;
    const newSummary = `Blocked: ${reason}\n${task["summary"] ?? ""}`.trim();
    await conn.query(
      `MATCH (m:Task {id: '${esc(String(task["id"]))}' })
       SET m.status = 'blocked', m.summary = '${esc(newSummary)}'`
    );
    console.log(`${chalk.yellow("Blocked:")} ${task["title"]}`);
    console.log(`${chalk.dim("Reason:")}  ${reason}`);
  });

tasksCmd
  .command("remove [target]")
  .description("Remove a task by queue position or id prefix; --all removes every task")
  .option("--all", "Remove all tasks for this project")
  .action(async (target: string | undefined, opts: { all?: boolean }) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;
    const { escape: esc } = await import("./kuzu-helpers.js");

    if (opts.all) {
      const { confirm } = await import("@inquirer/prompts");
      const ok = await confirm({ message: "Remove all tasks for this project?", default: false });
      if (!ok) { console.log(chalk.dim("Cancelled.")); return; }
      const rows = await queryAll(conn, `MATCH (t:Task {projectId: '${pid}'}) RETURN count(t) AS cnt`);
      const cnt = Number(rows[0]?.["cnt"] ?? 0);
      await conn.query(`MATCH (t:Task {projectId: '${pid}'}) DETACH DELETE t`);
      console.log(`${chalk.red("Removed")} ${cnt} task(s).`);
      return;
    }

    if (!target) {
      cerr("Specify a task position or id, or use --all.");
      process.exit(1);
    }

    const allRows = await queryAll(conn,
      `MATCH (t:Task {projectId: '${pid}'})
       WHERE t.status <> 'done'
       RETURN t ORDER BY t.taskOrder ASC`);
    const all = allRows.map((r) => r["t"] as Record<string, unknown>);

    let targetId: string | undefined;
    const pos = /^\d+$/.test(target) ? parseInt(target, 10) : NaN;
    if (!isNaN(pos) && pos >= 1 && pos <= all.length) {
      targetId = String(all[pos - 1]["id"]);
    } else {
      const match = all.find((t) => shortId(String(t["id"])).startsWith(target));
      targetId = match ? String(match["id"]) : undefined;
    }

    if (!targetId) {
      cerr(`No task matching "${target}". Run: pensive tasks`);
      process.exit(1);
    }

    const task = all.find((t) => String(t["id"]) === targetId);
    await conn.query(`MATCH (t:Task {id: '${esc(targetId)}'}) DETACH DELETE t`);
    console.log(`${chalk.red("Removed:")} ${task?.["title"]}`);
  });

tasksCmd
  .command("move <from> <to>")
  .description("Reorder queue: move task at position <from> to position <to>")
  .action(async (fromStr: string, toStr: string) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;

    const pendingRows = await queryAll(conn,
      `MATCH (m:Task {projectId: '${pid}', status: 'pending'})
       RETURN m ORDER BY m.taskOrder ASC`);
    const pending = pendingRows.map((r) => r["m"] as Record<string, unknown>);

    const from = parseInt(fromStr, 10);
    const to = parseInt(toStr, 10);

    if (isNaN(from) || isNaN(to) || from < 1 || to < 1 || from > pending.length || to > pending.length) {
      cerr(`Positions must be between 1 and ${pending.length}`);
      process.exit(1);
    }

    // Reorder in memory then renumber
    const [moved] = pending.splice(from - 1, 1);
    pending.splice(to - 1, 0, moved);

    const { escape: esc } = await import("./kuzu-helpers.js");
    for (let i = 0; i < pending.length; i++) {
      await conn.query(
        `MATCH (m:Task {id: '${esc(String(pending[i]["id"]))}' }) SET m.taskOrder = ${i + 1}`
      );
    }

    console.log(chalk.bold("Queue reordered:"));
    pending.forEach((t, i) =>
      console.log(`  ${chalk.dim(String(i + 1))}  ${t["title"]}`)
    );
  });

// ── Sessions ─────────────────────────────────────────────────────────────────

const sessionsCmd = program
  .command("sessions")
  .description("Manage project sessions");

sessionsCmd
  .argument("[id]", "Session id prefix to view in detail")
  .option("--all", "Show archived sessions too")
  .action(async (id: string | undefined, opts: { all?: boolean }) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;

    // Detail view
    if (id) {
      const rows = await queryAll(conn, `MATCH (s:Session {projectId: '${pid}'}) RETURN s`);
      const sessions = rows.map((r) => r["s"] as Record<string, unknown>);
      const match = sessions.find((s) => String(s["id"]).includes(id));
      if (!match) {
        cerr(`No session matching "${id}". Run: pensive sessions`);
        process.exit(1);
      }
      const sid = String(match["id"]);
      const ts = match["startedAt"] ? new Date(String(match["startedAt"])).toLocaleString() : "unknown";
      const archived = match["archived"] ? chalk.dim("  [archived]") : "";

      console.log(`\n${chalk.bold.cyan("── Session ──────────────────────────────")}`);
      console.log(`  ID:      ${chalk.dim("[" + sessionShortId(sid) + "]")}  ${chalk.dim(sid)}`);
      console.log(`  Started: ${chalk.dim(ts)}${archived}`);
      if (match["title"]) console.log(`  Title:   ${chalk.white(String(match["title"]))}`);

      if (match["summary"]) {
        console.log(`\n${chalk.bold.cyan("── Summary ──────────────────────────────")}`);
        console.log(chalk.dim(String(match["summary"])));
      }

      const memRows = await queryAll(conn,
        `MATCH (s:Session {id: '${sid}'})-[:HAS_MEMORY]->(m:Memory)
         RETURN m ORDER BY m.createdAt ASC`);
      if (memRows.length > 0) {
        console.log(`\n${chalk.bold.cyan("── Memories ─────────────────────────────")}`);
        memRows.forEach((r) => {
          const m = r["m"] as Record<string, unknown>;
          console.log(`  ${chalk.dim("[" + String(m["kind"]).toUpperCase() + "]")} ${chalk.white(String(m["title"]))}`);
          if (m["summary"]) console.log(`    ${chalk.dim(String(m["summary"]))}`);
        });
      } else {
        console.log(chalk.dim("\n  No memories for this session."));
      }
      console.log("");
      return;
    }

    // List view
    const filter = opts.all ? "" : " AND (s.archived = false OR s.archived IS NULL)";
    const listRows = await queryAll(conn,
      `MATCH (s:Session {projectId: '${pid}'})
       WHERE true${filter}
       RETURN s ORDER BY s.startedAt DESC`);
    if (listRows.length === 0) {
      console.log(opts.all ? "No sessions." : "No active sessions. Use --all to include archived.");
      return;
    }
    listRows.forEach((r) => {
      const s = r["s"] as Record<string, unknown>;
      const ts = s["startedAt"] ? new Date(String(s["startedAt"])).toLocaleString() : "unknown";
      const title = s["title"] ? `  ${s["title"]}` : "";
      const archived = s["archived"] ? chalk.dim("  [archived]") : "";
      console.log(`  ${chalk.dim("[" + sessionShortId(String(s["id"])) + "]")}  ${chalk.dim(ts)}${chalk.white(title)}${archived}`);
    });
  });

sessionsCmd
  .command("archive [target]")
  .description("Archive a session by id prefix; --all archives every session for this project")
  .option("--all", "Archive all sessions for this project")
  .action(async (target: string | undefined, opts: { all?: boolean }) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;
    const { escape: esc } = await import("./kuzu-helpers.js");

    if (opts.all) {
      const sRows = await queryAll(conn, `MATCH (s:Session {projectId: '${pid}'}) RETURN count(s) AS cnt`);
      await conn.query(`MATCH (s:Session {projectId: '${pid}'}) SET s.archived = true`);
      const sc = Number(sRows[0]?.["cnt"] ?? 0);
      console.log(`${chalk.green("Archived")} ${sc} session(s).`);
      return;
    }

    if (!target) {
      cerr("Specify a session id prefix, or use --all.");
      process.exit(1);
    }

    const rows = await queryAll(conn, `MATCH (s:Session {projectId: '${pid}'}) RETURN s`);
    const sessions = rows.map((r) => r["s"] as Record<string, unknown>);
    const match = sessions.find((s) => String(s["id"]).includes(target));
    if (!match) {
      cerr(`No session matching "${target}". Run: pensive sessions --all`);
      process.exit(1);
    }
    const sid = String(match["id"]);
    await conn.query(`MATCH (s:Session {id: '${esc(sid)}'}) SET s.archived = true`);
    console.log(`${chalk.green("Archived")} session ${chalk.dim("[" + sessionShortId(sid) + "]")}.`);
  });

sessionsCmd
  .command("remove [target]")
  .description("Remove a session by id prefix; --all removes every session and its memories")
  .option("--all", "Remove all sessions (and their memories) for this project")
  .action(async (target: string | undefined, opts: { all?: boolean }) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;
    const { escape: esc } = await import("./kuzu-helpers.js");

    if (opts.all) {
      const { confirm } = await import("@inquirer/prompts");
      const ok = await confirm({ message: "Remove all sessions and memories for this project?", default: false });
      if (!ok) { console.log(chalk.dim("Cancelled.")); return; }
      const mRows = await queryAll(conn, `MATCH (m:Memory {projectId: '${pid}'}) RETURN count(m) AS cnt`);
      const sRows = await queryAll(conn, `MATCH (s:Session {projectId: '${pid}'}) RETURN count(s) AS cnt`);
      await conn.query(`MATCH (m:Memory {projectId: '${pid}'}) DETACH DELETE m`);
      await conn.query(`MATCH (s:Session {projectId: '${pid}'}) DETACH DELETE s`);
      const sc = Number(sRows[0]?.["cnt"] ?? 0);
      const mc = Number(mRows[0]?.["cnt"] ?? 0);
      console.log(`${chalk.red("Removed")} ${sc} session(s), ${mc} memory node(s).`);
      return;
    }

    if (!target) {
      cerr("Specify a session id prefix, or use --all.");
      process.exit(1);
    }

    const rows = await queryAll(conn,
      `MATCH (s:Session {projectId: '${pid}'}) RETURN s`);
    const sessions = rows.map((r) => r["s"] as Record<string, unknown>);
    const match = sessions.find((s) => String(s["id"]).includes(target));
    if (!match) {
      cerr(`No session matching "${target}". Run: pensive sessions`);
      process.exit(1);
    }
    const sid = String(match["id"]);
    await conn.query(`MATCH (m:Memory {sessionId: '${esc(sid)}'}) DETACH DELETE m`);
    await conn.query(`MATCH (s:Session {id: '${esc(sid)}'}) DETACH DELETE s`);
    console.log(`${chalk.red("Removed")} session ${chalk.dim("[" + sessionShortId(sid) + "]")} and its memories.`);
  });

// ── Memories ──────────────────────────────────────────────────────────────────

const memoriesCmd = program
  .command("memories")
  .description("Browse and manage memory nodes");

memoriesCmd
  .argument("[id]", "Memory id prefix to view in detail")
  .option("--session <session>", "Filter by session id prefix")
  .option("--kind <kind>", "Filter by kind (e.g. decision, fact, learning)")
  .action(async (id: string | undefined, opts: { session?: string; kind?: string }) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;

    // Detail view
    if (id) {
      const rows = await queryAll(conn, `MATCH (m:Memory {projectId: '${pid}'}) RETURN m`);
      const memories = rows.map((r) => r["m"] as Record<string, unknown>);
      const match = memories.find((m) => String(m["id"]).includes(id));
      if (!match) {
        cerr(`No memory matching "${id}". Run: pensive memories`);
        process.exit(1);
      }
      console.log(`\n${chalk.bold.cyan("── Memory ───────────────────────────────")}`);
      console.log(`  ID:      ${chalk.dim(String(match["id"]))}`);
      console.log(`  Kind:    ${chalk.white(String(match["kind"] ?? ""))}`);
      console.log(`  Title:   ${chalk.white(String(match["title"] ?? ""))}`);
      if (match["summary"]) console.log(`  Summary: ${chalk.dim(String(match["summary"]))}`);
      if (match["recallCue"]) console.log(`  Cue:     ${chalk.dim(String(match["recallCue"]))}`);
      if (match["createdAt"]) console.log(`  Created: ${chalk.dim(new Date(String(match["createdAt"])).toLocaleString())}`);
      if (match["sessionId"]) console.log(`  Session: ${chalk.dim(String(match["sessionId"]))}`);

      console.log("");
      return;
    }

    // List view
    let filters = `WHERE m.projectId = '${pid}'`;
    if (opts.kind) filters += ` AND m.kind = '${opts.kind}'`;
    if (opts.session) {
      const sRows = await queryAll(conn, `MATCH (s:Session {projectId: '${pid}'}) RETURN s`);
      const sessions = sRows.map((r) => r["s"] as Record<string, unknown>);
      const sessionMatch = sessions.find((s) => String(s["id"]).includes(opts.session!));
      if (!sessionMatch) { cerr(`No session matching "${opts.session}".`); process.exit(1); }
      filters += ` AND m.sessionId = '${String(sessionMatch["id"])}'`;
    }

    const listRows = await queryAll(conn,
      `MATCH (m:Memory) ${filters} RETURN m ORDER BY m.createdAt DESC`);
    if (listRows.length === 0) {
      console.log(chalk.dim("No memories found."));
      return;
    }
    listRows.forEach((r) => {
      const m = r["m"] as Record<string, unknown>;
      const ts = m["createdAt"] ? chalk.dim(new Date(String(m["createdAt"])).toLocaleDateString()) : "";
      const kind = chalk.dim("[" + String(m["kind"] ?? "").toUpperCase() + "]");
      console.log(`  ${kind}  ${chalk.white(String(m["title"] ?? ""))}  ${ts}`);
    });
  });

memoriesCmd
  .command("remove <id>")
  .description("Remove a memory node by id prefix")
  .action(async (id: string) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;
    const { escape: esc } = await import("./kuzu-helpers.js");

    const rows = await queryAll(conn, `MATCH (m:Memory {projectId: '${pid}'}) RETURN m`);
    const memories = rows.map((r) => r["m"] as Record<string, unknown>);
    const match = memories.find((m) => String(m["id"]).includes(id));
    if (!match) {
      cerr(`No memory matching "${id}". Run: pensive memories`);
      process.exit(1);
    }
    const mid = String(match["id"]);
    await conn.query(`MATCH (m:Memory {id: '${esc(mid)}'}) DETACH DELETE m`);
    console.log(`${chalk.red("Removed")} memory ${chalk.dim(mid.slice(0, 8))}: ${chalk.white(String(match["title"]))}`);
  });

// ── Chat ──────────────────────────────────────────────────────────────────────

program
  .command("chat")
  .description("Interactive chat with your project memories as context")
  .option("-k, --top <n>", "Number of memories to surface per message", "5")
  .action(async (opts) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;
    const { escape: esc } = await import("./kuzu-helpers.js");
    const { default: crypto } = await import("crypto");

    const topK = parseInt(opts.top ?? "5", 10);

    // ── Tool definitions ──────────────────────────────────────────────────────
    const TOOLS: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "search_memories",
          description: "Search the project memory graph for information related to a query. Use this to find relevant decisions, facts, tasks, and other memories.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "The search query" },
              top_k: { type: "string", description: "Number of results to return (default 5)" },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "list_tasks",
          description: "List the current tasks for this project (active, queued, blocked, recently done).",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "add_task",
          description: "Add a new task to the project queue.",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "Task title" },
              summary: { type: "string", description: "Optional task summary/details" },
            },
            required: ["title"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "set_task_summary",
          description: "Set or update the summary/details for a task by its title or id prefix.",
          parameters: {
            type: "object",
            properties: {
              target: { type: "string", description: "Task title substring or id prefix" },
              summary: { type: "string", description: "New summary text" },
            },
            required: ["target", "summary"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "complete_task",
          description: "Mark a task as done by title substring, id prefix, or 'active' for the current active task.",
          parameters: {
            type: "object",
            properties: {
              target: { type: "string", description: "Task title substring, id prefix, or 'active'" },
            },
            required: ["target"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "start_task",
          description: "Set a pending task as the active task by title substring or id prefix. Pushes any current active task back to the queue.",
          parameters: {
            type: "object",
            properties: {
              target: { type: "string", description: "Task title substring or id prefix" },
            },
            required: ["target"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "add_subtask",
          description: "Add a subtask under a parent task. The parent is matched by title substring or id prefix, or use 'active' for the current active task.",
          parameters: {
            type: "object",
            properties: {
              parent: { type: "string", description: "Parent task title substring, id prefix, or 'active'" },
              title: { type: "string", description: "Subtask title" },
              summary: { type: "string", description: "Optional subtask summary" },
            },
            required: ["parent", "title"],
          },
        },
      },
    ];

    // ── Tool executor ─────────────────────────────────────────────────────────
    async function executeTool(name: string, args: Record<string, string>): Promise<string> {
      if (name === "search_memories") {
        const k = parseInt(args["top_k"] ?? String(topK), 10);
        const results = await searchMemoriesWithGraph(conn, pid, args["query"] ?? "", k);
        if (results.length === 0) return "No memories found.";
        return results
          .map((m) => `[${m.kind.toUpperCase()}] ${m.title}\n${m.summary}`)
          .join("\n\n");
      }

      if (name === "list_tasks") {
        const activeR = await queryAll(conn, `MATCH (t:Task {projectId: '${pid}', status: 'active'}) WHERE t.parentId = '' OR t.parentId IS NULL RETURN t LIMIT 1`);
        const pendingR = await queryAll(conn, `MATCH (t:Task {projectId: '${pid}', status: 'pending'}) WHERE t.parentId = '' OR t.parentId IS NULL RETURN t ORDER BY t.taskOrder ASC`);
        const blockedR = await queryAll(conn, `MATCH (t:Task {projectId: '${pid}', status: 'blocked'}) WHERE t.parentId = '' OR t.parentId IS NULL RETURN t ORDER BY t.createdAt DESC`);
        const doneR = await queryAll(conn, `MATCH (t:Task {projectId: '${pid}', status: 'done'}) WHERE t.parentId = '' OR t.parentId IS NULL RETURN t ORDER BY t.createdAt DESC LIMIT 5`);

        const lines: string[] = [];
        const active = activeR[0]?.["t"] as Record<string, unknown> | undefined;
        if (active) lines.push(`ACTIVE: ${active["title"]}${active["summary"] ? " — " + active["summary"] : ""}`);
        if (pendingR.length > 0) {
          lines.push("QUEUE:");
          pendingR.forEach((r, i) => {
            const t = r["t"] as Record<string, unknown>;
            lines.push(`  ${i + 1}. ${t["title"]}${t["summary"] ? " — " + t["summary"] : ""}`);
          });
        }
        if (blockedR.length > 0) {
          lines.push("BLOCKED:");
          blockedR.forEach((r) => {
            const t = r["t"] as Record<string, unknown>;
            lines.push(`  ✗ ${t["title"]}`);
          });
        }
        if (doneR.length > 0) {
          lines.push("RECENTLY DONE:");
          doneR.forEach((r) => { const t = r["t"] as Record<string, unknown>; lines.push(`  ✓ ${t["title"]}`); });
        }
        return lines.length > 0 ? lines.join("\n") : "No tasks.";
      }

      if (name === "add_task") {
        const title = args["title"];
        if (!title) return "Error: title is required.";
        const orderR = await queryAll(conn, `MATCH (t:Task {projectId: '${pid}', status: 'pending'}) RETURN max(t.taskOrder) AS maxOrder`);
        const maxOrder = Number(orderR[0]?.["maxOrder"] ?? 0);
        const id = `task_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
        const summary = args["summary"] ?? "";
        await conn.query(
          `CREATE (t:Task {id: '${esc(id)}', title: '${esc(title)}', summary: '${esc(summary)}', status: 'pending', taskOrder: ${maxOrder + 1}, projectId: '${esc(pid)}', createdAt: '${new Date().toISOString()}', parentId: ''})`
        );
        await conn.query(`MATCH (p:Project {id: '${esc(pid)}'}), (t:Task {id: '${esc(id)}'}) CREATE (p)-[:HAS_TASK]->(t)`);
        return `Task added: "${title}" [${id.slice(5, 11)}]${summary ? "\nSummary: " + summary : ""}`;
      }

      if (name === "set_task_summary") {
        const target = args["target"];
        const summary = args["summary"];
        if (!target || !summary) return "Error: target and summary are required.";
        const allR = await queryAll(conn, `MATCH (t:Task {projectId: '${pid}'}) WHERE t.status <> 'done' RETURN t ORDER BY t.taskOrder ASC`);
        const all = allR.map((r) => r["t"] as Record<string, unknown>);
        const match = all.find((t) =>
          String(t["title"]).toLowerCase().includes(target.toLowerCase()) ||
          String(t["id"]).includes(target)
        );
        if (!match) return `No task matching "${target}".`;
        await conn.query(`MATCH (t:Task {id: '${esc(String(match["id"]))}'}) SET t.summary = '${esc(summary)}'`);
        return `Summary set for "${match["title"]}".`;
      }

      if (name === "complete_task") {
        const target = args["target"];
        if (!target) return "Error: target is required.";
        const allR = await queryAll(conn, `MATCH (t:Task {projectId: '${pid}'}) WHERE t.status <> 'done' RETURN t ORDER BY t.taskOrder ASC`);
        const all = allR.map((r) => r["t"] as Record<string, unknown>);
        let task: Record<string, unknown> | undefined;
        if (target === "active") {
          task = all.find((t) => t["status"] === "active");
        } else {
          task = all.find((t) =>
            String(t["title"]).toLowerCase().includes(target.toLowerCase()) ||
            String(t["id"]).includes(target)
          );
        }
        if (!task) return `No task matching "${target}".`;
        await conn.query(`MATCH (t:Task {id: '${esc(String(task["id"]))}'}) SET t.status = 'done'`);
        return `Marked done: "${task["title"]}"`;
      }

      if (name === "start_task") {
        const target = args["target"];
        if (!target) return "Error: target is required.";
        const pendingR = await queryAll(conn, `MATCH (t:Task {projectId: '${pid}', status: 'pending'}) RETURN t ORDER BY t.taskOrder ASC`);
        const pending = pendingR.map((r) => r["t"] as Record<string, unknown>);
        const task = pending.find((t) =>
          String(t["title"]).toLowerCase().includes(target.toLowerCase()) ||
          String(t["id"]).includes(target)
        );
        if (!task) return `No pending task matching "${target}".`;
        const minR = await queryAll(conn, `MATCH (t:Task {projectId: '${esc(pid)}', status: 'pending'}) RETURN min(t.taskOrder) AS minOrder`);
        const minOrder = Number(minR[0]?.["minOrder"] ?? 1);
        await conn.query(`MATCH (t:Task {projectId: '${esc(pid)}', status: 'active'}) SET t.status = 'pending', t.taskOrder = ${minOrder - 1}`);
        await conn.query(`MATCH (t:Task {id: '${esc(String(task["id"]))}'}) SET t.status = 'active'`);
        return `Now active: "${task["title"]}"`;
      }

      if (name === "add_subtask") {
        const parentTarget = args["parent"];
        const title = args["title"];
        if (!parentTarget || !title) return "Error: parent and title are required.";
        const allR = await queryAll(conn, `MATCH (t:Task {projectId: '${pid}'}) WHERE t.status <> 'done' RETURN t ORDER BY t.taskOrder ASC`);
        const all = allR.map((r) => r["t"] as Record<string, unknown>);
        let parentTask: Record<string, unknown> | undefined;
        if (parentTarget === "active") {
          parentTask = all.find((t) => t["status"] === "active");
        } else {
          parentTask = all.find((t) =>
            String(t["title"]).toLowerCase().includes(parentTarget.toLowerCase()) ||
            String(t["id"]).includes(parentTarget)
          );
        }
        if (!parentTask) return `No task matching "${parentTarget}".`;
        const parentId = String(parentTask["id"]);
        const orderR = await queryAll(conn, `MATCH (t:Task {projectId: '${pid}', status: 'pending'}) RETURN max(t.taskOrder) AS maxOrder`);
        const maxOrder = Number(orderR[0]?.["maxOrder"] ?? 0);
        const id = `task_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
        const summary = args["summary"] ?? "";
        await conn.query(
          `CREATE (t:Task {id: '${esc(id)}', title: '${esc(title)}', summary: '${esc(summary)}', status: 'pending', taskOrder: ${maxOrder + 1}, projectId: '${esc(pid)}', createdAt: '${new Date().toISOString()}', parentId: '${esc(parentId)}'})`
        );
        await conn.query(`MATCH (p:Project {id: '${esc(pid)}'}), (t:Task {id: '${esc(id)}'}) CREATE (p)-[:HAS_TASK]->(t)`);
        return `Subtask added: "${title}" under "${parentTask["title"]}"`;
      }

      return `Unknown tool: ${name}`;
    }

    // ── UI setup ──────────────────────────────────────────────────────────────
    const activeRows = await queryAll(conn, `MATCH (t:Task {projectId: '${pid}', status: 'active'}) RETURN t LIMIT 1`);
    const activeTask = activeRows[0]?.["t"] as Record<string, unknown> | undefined;

    console.log(chalk.bold.cyan(`\n── Pensive Chat ─────────────────────────`));
    console.log(`  Project: ${chalk.white(config.projectName)}`);
    console.log(`  Model:   ${chalk.dim(config.llm?.model ?? "not set")}`);
    if (activeTask) console.log(`  Task:    ${chalk.dim(String(activeTask["title"]))}`);
    console.log(chalk.dim("\n  Type your message. Ctrl+C or /quit to exit.\n"));

    const { createInterface } = await import("readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    type ChatMsg = ChatMessage;
    const history: ChatMsg[] = [];

    const ask = (prompt: string): Promise<string> =>
      new Promise((resolve, reject) => {
        rl.question(prompt, resolve);
        rl.once("close", () => reject(new Error("closed")));
      });

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let userInput: string;
      try {
        userInput = (await ask(chalk.bold.cyan("You: "))).trim();
      } catch {
        break;
      }

      if (!userInput || userInput === "/quit" || userInput === "/exit") break;

      // System prompt
      const systemParts = [
        `You are a helpful assistant for the project "${config.projectName}".`,
        `You have tools to search memories, list tasks, add tasks, and set task summaries.`,
        `When asked to perform an action (add a task, etc.), use the appropriate tool — do not just describe it.`,
        `When asked about project information, use search_memories to find relevant context.`,
      ];
      if (activeTask) systemParts.push(`\nActive task: ${activeTask["title"]}`);

      const messages: ChatMsg[] = [
        { role: "system", content: systemParts.join("\n") },
        ...history,
        { role: "user", content: userInput },
      ];

      try {
        // Agentic loop: keep running until no more tool calls
        let iterMessages = messages;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          process.stdout.write(chalk.dim("  [thinking…]"));
          const response = await llmChatMessages(iterMessages, TOOLS);
          process.stdout.write("\r\x1b[K");

          if (response.tool_calls && response.tool_calls.length > 0) {
            // Execute each tool call
            const assistantMsg: ChatMsg = { role: "assistant", content: response.content, tool_calls: response.tool_calls };
            iterMessages = [...iterMessages, assistantMsg];

            for (const call of response.tool_calls) {
              let args: Record<string, string> = {};
              try { args = JSON.parse(call.function.arguments); } catch { /* */ }
              console.log(chalk.dim(`  [tool] ${call.function.name}(${Object.entries(args).map(([k, v]) => `${k}: "${v}"`).join(", ")})`));
              const result = await executeTool(call.function.name, args);
              console.log(chalk.dim(`  → ${result.split("\n")[0]}${result.includes("\n") ? " …" : ""}`));
              iterMessages = [...iterMessages, { role: "tool", content: result, tool_call_id: call.id }];
            }
            // Loop to get final response after tool results
            continue;
          }

          // Final response
          const text = response.content ?? "";
          console.log(`\n${chalk.bold.green("Assistant:")} ${text}\n`);
          history.push({ role: "user", content: userInput });
          history.push({ role: "assistant", content: text });
          break;
        }
      } catch (err) {
        process.stdout.write("\r\x1b[K");
        cerr(`LLM error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    rl.close();
    console.log(chalk.dim("\nGoodbye."));
  });

// ─────────────────────────────────────────────────────────────────────────────

const HOOK_SCRIPTS: Record<string, string> = {
  "stop":           "hook.js",
  "user-prompt":    "hook-user-prompt.js",
  "compact":        "hook-compact.js",
  "post-tool-use":  "hook-post-tool-use.js",
  "session-start":  "hook-session-start.js",
};

program
  .command("hook [type]")
  .description("Run a Claude Code hook (reads JSON payload from stdin)")
  .action((type: string | undefined) => {
    if (!type) {
      console.log(`${chalk.bold("Usage:")} pensive hook <type>\n`);
      console.log(chalk.bold("Available hook types:"));
      for (const [name, script] of Object.entries(HOOK_SCRIPTS)) {
        console.log(`  ${chalk.white(name.padEnd(16))} ${chalk.dim("(" + script + ")")}`);
      }
      console.log(chalk.dim("\nThese are registered automatically in .claude/settings.json and .github/settings.json"));
      console.log(chalk.dim("by running: pensive init"));
      process.exit(0);
    }
    const script = HOOK_SCRIPTS[type];
    if (!script) {
      cerr(`Unknown hook type: ${type}`);
      cerr(`Valid types: ${Object.keys(HOOK_SCRIPTS).join(", ")}`);
      process.exit(1);
    }
    const scriptPath = path.join(__dirname, script);
    const result = spawnSync(process.execPath, [scriptPath], { stdio: "inherit" });
    process.exit(result.status ?? 0);
  });

program.parse(process.argv);
