#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import * as net from "net";
import { execSync, spawnSync } from "child_process";
import { initProject } from "./init.js";
import { ingestTurn } from "./index.js";
import { detectProject } from "./detect-project.js";
import { getDb, applySchema } from "./db.js";
import { queryAll } from "./kuzu-helpers.js";
import {
  readProjectConfig,
  writeProjectConfig,
  PROVIDER_DEFAULTS,
  type ProjectConfig,
} from "./config.js";
import { embed, llmComplete } from "./llm.js";
import { searchGraph } from "./search.js";
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

  console.log(`\n${chalk.green("Saved to")} ${chalk.dim(".pensieve/config.json")}`);
  console.log(`  LLM:       ${chalk.white(llmProvider)} / ${chalk.dim(llmModel)}`);
  console.log(`  Embedding: ${chalk.white(embProvider)} / ${chalk.dim(embModel)}`);
}

const program = new Command();

program
  .name("pensieve")
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
            const projectMemoryDir = path.join(detected.projectRoot, ".pensieve");
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
        cerr("No pensieve project found. Run: pensieve init");
        process.exit(1);
      }

      const projectMemoryDir = path.join(
        detected.projectRoot,
        ".pensieve"
      );
      const configPath = path.join(projectMemoryDir, "config.json");

      if (!fs.existsSync(configPath)) {
        cerr("Not initialized. Run: pensieve init");
        process.exit(1);
      }

      const config: ProjectConfig = JSON.parse(
        fs.readFileSync(configPath, "utf-8")
      );
      const { conn } = await getDb(projectMemoryDir);

      const { querySessionBundle } = await import("./session-bundle.js");
      const output = await querySessionBundle(conn, config.projectId, "", { includeMemories: true });
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
      console.log("No pensieve project found. Run: pensieve init");
      return;
    }

    const projectMemoryDir = path.join(detected.projectRoot, ".pensieve");
    const configPath = path.join(projectMemoryDir, "config.json");

    if (!fs.existsSync(configPath)) {
      console.log("Not initialized. Run: pensieve init");
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
      const { conn } = await getDb(projectMemoryDir);

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
  .command("search [query]")
  .description("Semantic search across memories, tasks, and sessions")
  .option("-k, --top <n>", "Number of results", "10")
  .option("--file <path>", "Find turns and memories from sessions that referenced this file")
  .action(async (query: string | undefined, opts) => {
    const detected = detectProject(process.cwd());
    if (!detected) { cerr("No pensieve project found. Run: pensieve init"); process.exit(1); }

    const projectMemoryDir = path.join(detected.projectRoot, ".pensieve");
    const config = readProjectConfig(projectMemoryDir);
    const { conn } = await getDb(projectMemoryDir);
    await applySchema(conn, projectMemoryDir);
    const pid = config.projectId;

    if (!query && !opts.file) {
      cerr("Provide a query or --file <path>");
      process.exit(1);
    }

    // ── --file mode: traverse Turn-[:REFERENCES]->File->Session->Memory ──────
    if (opts.file) {
      const filePath = path.relative(detected.projectRoot, path.resolve(process.cwd(), opts.file));
      const { escape: esc } = await import("./kuzu-helpers.js");

      const rows = await queryAll(conn,
        `MATCH (f:File {projectId: '${esc(pid)}'})\
         WHERE f.path = '${esc(filePath)}' OR f.path ENDS WITH '${esc(filePath)}'\
         MATCH (t:Turn)-[:REFERENCES]->(f)\
         MATCH (s:Session)-[:HAS_TURN]->(t)\
         OPTIONAL MATCH (s)-[:HAS_MEMORY]->(m:Memory)\
         RETURN t, m, s.title AS sessionTitle, f.path AS filePath\
         ORDER BY t.timestamp DESC`
      );

      if (rows.length === 0) {
        console.log(chalk.dim(`No results for file: ${filePath}`));
        return;
      }

      console.log(`\n${chalk.dim("File:")} ${chalk.white(filePath)}\n`);

      // Group by turn, collect memories per session
      const byTurn = new Map<string, { turn: Record<string, unknown>; sessionTitle: string; memories: Record<string, unknown>[] }>();
      for (const row of rows) {
        const t = row["t"] as Record<string, unknown>;
        const tid = String(t["id"]);
        if (!byTurn.has(tid)) {
          byTurn.set(tid, { turn: t, sessionTitle: String(row["sessionTitle"] ?? ""), memories: [] });
        }
        if (row["m"]) byTurn.get(tid)!.memories.push(row["m"] as Record<string, unknown>);
      }

      for (const { turn, sessionTitle, memories } of byTurn.values()) {
        const ts = turn["timestamp"] ? new Date(String(turn["timestamp"])).toLocaleString() : "";
        console.log(`${chalk.bold.cyan("──")} ${chalk.bold("[TURN]")} ${chalk.white(String(turn["userText"] ?? "").slice(0, 80))}  ${chalk.dim(ts)}`);
        if (sessionTitle) console.log(`   ${chalk.dim("session:")} ${sessionTitle}`);
        const assistantText = String(turn["assistantText"] ?? "").slice(0, 120);
        if (assistantText) console.log(`   ${chalk.dim(assistantText + (String(turn["assistantText"] ?? "").length > 120 ? "…" : ""))}`);
        if (memories.length > 0) {
          console.log(`   ${chalk.dim("memories:")}`);
          for (const m of memories) {
            console.log(`     ${chalk.dim("[" + String(m["kind"] ?? "memory").toUpperCase() + "]")} ${String(m["title"] ?? "")}`);
          }
        }
        console.log();
      }
      return;
    }

    // ── normal semantic search ────────────────────────────────────────────────
    const topK = parseInt(opts.top ?? "10", 10);
    const results = await searchGraph(conn, pid, query!, topK);

    if (results.length === 0) {
      console.log(chalk.dim("No results found."));
      return;
    }

    console.log(`\n${chalk.dim("Query:")} "${chalk.white(query)}"\n`);

    for (const r of results) {
      const fmtDate = (d?: string) => d ? chalk.dim(new Date(d).toLocaleString()) : "";
      if (r.nodeType === "memory") {
        console.log(`${chalk.bold.cyan("──")} ${chalk.dim("[" + shortId(String(r.id)) + "]")} ${chalk.bold("[" + (r.kind ?? "memory").toUpperCase() + "]")} ${chalk.white(r.title)}  ${chalk.dim("(score: " + r.score.toFixed(4) + ")")}  ${fmtDate(r.createdAt)}`);
        if (r.summary) console.log(`   ${chalk.dim(r.summary)}`);
        if (r.sessionTitle) console.log(`   ${chalk.dim("session:")} ${r.sessionTitle}`);
        if (r.breadcrumbs && r.breadcrumbs.length > 0) {
          const crumbList = r.breadcrumbs.map((c) => `${chalk.dim(shortId(String(c.id)))} ${(c.kind ?? "memory").toUpperCase()}: ${c.title}`).join("  ·  ");
          console.log(`   ${chalk.dim("↳ also from this session:")} ${chalk.dim(crumbList)}`);
        }
      } else if (r.nodeType === "task") {
        const statusColor = r.status === "active" ? chalk.green : r.status === "blocked" ? chalk.yellow : r.status === "done" ? chalk.dim : chalk.white;
        console.log(`${chalk.bold.cyan("──")} ${chalk.dim("[" + shortId(String(r.id)) + "]")} ${chalk.bold("[TASK]")} ${chalk.white(r.title)}  ${statusColor(r.status ?? "")}  ${chalk.dim("(score: " + r.score.toFixed(4) + ")")}  ${fmtDate(r.createdAt)}`);
        if (r.summary) console.log(`   ${chalk.dim(r.summary)}`);
      } else if (r.nodeType === "turn") {
        console.log(`${chalk.bold.cyan("──")} ${chalk.dim("[" + shortId(String(r.id)) + "]")} ${chalk.bold("[TURN]")} ${chalk.white(r.title)}  ${chalk.dim("(score: " + r.score.toFixed(4) + ")")}  ${fmtDate(r.createdAt)}`);
        if (r.summary) console.log(`   ${chalk.dim(r.summary.slice(0, 120) + (r.summary.length > 120 ? "…" : ""))}`);
      } else {
        console.log(`${chalk.bold.cyan("──")} ${chalk.dim("[" + shortId(String(r.id)) + "]")} ${chalk.bold("[SESSION]")} ${chalk.white(r.title)}  ${chalk.dim("(score: " + r.score.toFixed(4) + ")")}  ${fmtDate(r.startedAt)}`);
        if (r.summary) console.log(`   ${chalk.dim(r.summary.slice(0, 120) + (r.summary.length > 120 ? "…" : ""))}`);
      }
      console.log();
    }
  });

program
  .command("backfill-embeddings")
  .description("Generate and store embeddings for all nodes missing them (Memory, Task, Session, Turn)")
  .action(async () => {
    const detected = detectProject(process.cwd());
    if (!detected) { cerr("No pensieve project found. Run: pensieve init"); process.exit(1); }

    const projectMemoryDir = path.join(detected.projectRoot, ".pensieve");
    const config = readProjectConfig(projectMemoryDir);
    const { conn } = await getDb(projectMemoryDir);
    await applySchema(conn, projectMemoryDir);
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

    const turnRows = (await queryAll(conn,
      `MATCH (t:Turn {projectId: '${pid}'}) WHERE t.embedding IS NULL OR size(t.embedding) = 0
       RETURN t.id AS id, t.userText AS userText, t.assistantText AS assistantText`
    )).map((r): BackfillRow => ({
      id: String(r["id"]),
      text: `user: ${r["userText"]}\nassistant: ${r["assistantText"]}`,
      setQuery: (id, lit) => `MATCH (t:Turn {id: '${id}'}) SET t.embedding = ${lit}`,
    }));

    const rows = [...memRows, ...taskRows, ...sessionRows, ...turnRows];

    if (rows.length === 0) {
      console.log(chalk.dim("All nodes already have embeddings."));
      return;
    }

    console.log(chalk.cyan(`Backfilling ${rows.length} node(s) (${memRows.length} memories, ${taskRows.length} tasks, ${sessionRows.length} sessions, ${turnRows.length} turns)...`));
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
      cerr("No pensieve project found. Run: pensieve init");
      process.exit(1);
    }

    const projectMemoryDir = path.join(detected.projectRoot, ".pensieve");
    const configPath = path.join(projectMemoryDir, "config.json");

    if (!fs.existsSync(configPath)) {
      cerr("Not initialized. Run: pensieve init");
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
      cerr("No pensieve project found. Run: pensieve init");
      process.exit(1);
    }
    const projectMemoryDir = path.join(detected.projectRoot, ".pensieve");
    const configPath = path.join(projectMemoryDir, "config.json");
    if (!fs.existsSync(configPath)) {
      cerr("Not initialized. Run: pensieve init");
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
      console.log(chalk.dim("\n  No description yet. Set one with: pensieve project set description \"...\""));
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
      writeProjectConfig(path.join(detectProject(process.cwd())!.projectRoot, ".pensieve"), config);
    } else if (field === "remoteUrl") {
      config.remoteUrl = value;
      writeProjectConfig(path.join(detectProject(process.cwd())!.projectRoot, ".pensieve"), config);
    }

    console.log(`${chalk.green("Set")} ${chalk.white(field)}: ${value}`);
  });

// ── Tasks ────────────────────────────────────────────────────────────────────

async function getProjectDb(cwd: string) {
  const detected = detectProject(cwd);
  if (!detected) {
    cerr("No pensieve project found. Run: pensieve init");
    process.exit(1);
  }
  const projectMemoryDir = path.join(detected.projectRoot, ".pensieve");
  const configPath = path.join(projectMemoryDir, "config.json");
  if (!fs.existsSync(configPath)) {
    cerr("Not initialized. Run: pensieve init");
    process.exit(1);
  }
  const config = readProjectConfig(projectMemoryDir);
  const { conn } = await getDb(projectMemoryDir);
  await applySchema(conn, projectMemoryDir); // runs migrations; all statements are idempotent
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
  subtasks: Record<string, unknown>[] = [],
  suggestedDone: Record<string, unknown>[] = []
): void {
  if (!active && pending.length === 0 && blocked.length === 0 && done.length === 0 && suggestedDone.length === 0) {
    console.log("No tasks. Add one: pensieve tasks add \"title\"");
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

  if (suggestedDone.length > 0) {
    console.log(chalk.bold.cyan("\n  MAY BE DONE"));
    suggestedDone.forEach((t) => {
      const id = shortId(String(t["id"]));
      console.log(`  ${chalk.cyan("?")}  ${chalk.dim("[" + id + "]")}  ${chalk.cyan(String(t["title"]))}`);
      if (t["doneSuggestion"]) {
        console.log(chalk.dim(`         "${String(t["doneSuggestion"]).slice(0, 100)}"`));
      }
      console.log(chalk.dim(`         → confirm: pensieve tasks done ${id}`));
    });
  }

  if (done.length > 0) {
    console.log(chalk.dim("\n  DONE"));
    done.forEach((t) => {
      const id = shortId(String(t["id"]));
      const subCount = subtasks.filter((s) => String(s["parentId"]) === String(t["id"])).length;
      const subtasksBadge = subCount > 0 ? chalk.dim(` (${subCount} subtask${subCount > 1 ? "s" : ""})`) : "";
      console.log(chalk.dim(`  ✓  [${id}]${subtasksBadge}  ${t["title"]}`));
    });
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
       RETURN m ORDER BY m.completedAt DESC, m.createdAt DESC`) : [];
    const subtaskRows = await queryAll(conn,
      `MATCH (t:Task {projectId: '${pid}'}) WHERE t.parentId <> '' RETURN t`);
    const suggestedDoneRows = await queryAll(conn,
      `MATCH (m:Task {projectId: '${pid}'})
       WHERE (m.doneSuggestion <> '' AND m.doneSuggestion IS NOT NULL)
       AND m.status <> 'done'
       AND (m.parentId = '' OR m.parentId IS NULL)
       RETURN m ORDER BY m.taskOrder ASC`);

    printTaskList(
      activeRows[0]?.["m"] as Record<string, unknown> | undefined,
      pendingRows.map((r) => r["m"] as Record<string, unknown>),
      blockedRows.map((r) => r["m"] as Record<string, unknown>),
      doneRows.map((r) => r["m"] as Record<string, unknown>),
      subtaskRows.map((r) => r["t"] as Record<string, unknown>),
      suggestedDoneRows.map((r) => r["m"] as Record<string, unknown>)
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
        cerr(`No task matching "${opts.parent}". Run: pensieve tasks`);
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
      cerr(`No task matching "${target}". Run: pensieve tasks`);
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
      cerr(`No task matching "${target}". Run: pensieve tasks`);
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
      cerr(`No pending task matching "${target}". Run: pensieve tasks`);
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
      `MATCH (m:Task {id: '${esc(target_id)}'}) SET m.status = 'active', m.doneSuggestion = ''`
    );

    const title = pending.find((t) => String(t["id"]) === target_id)?.["title"];
    console.log(`${chalk.green("Active:")} ${title}`);
  });

tasksCmd
  .command("done [targets...]")
  .description("Mark tasks as done — active task if no args, or by id prefix/queue position")
  .option("-n, --note <text>", "brief summary of what was accomplished")
  .action(async (targets: string[], opts: { note?: string }) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;
    const { escape: esc } = await import("./kuzu-helpers.js");
    const note = opts.note ?? "";

    if (targets.length === 0) {
      const rows = await queryAll(conn,
        `MATCH (m:Task {projectId: '${pid}', status: 'active'})
         RETURN m LIMIT 1`);
      if (rows.length === 0) { console.log(chalk.dim("No active task.")); return; }
      const task = rows[0]["m"] as Record<string, unknown>;
      await conn.query(`MATCH (m:Task {id: '${esc(String(task["id"]))}' }) SET m.status = 'done', m.completedAt = '${new Date().toISOString()}', m.completionNote = '${esc(note)}', m.doneSuggestion = ''`);
      console.log(`${chalk.green("Done:")} ${task["title"]}`);
      if (note) console.log(chalk.dim(`  "${note}"`));
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
      await conn.query(`MATCH (m:Task {id: '${esc(String(task["id"]))}' }) SET m.status = 'done', m.completedAt = '${new Date().toISOString()}', m.completionNote = '${esc(note)}', m.doneSuggestion = ''`);
      console.log(`${chalk.green("Done:")} ${task["title"]}`);
      if (note) console.log(chalk.dim(`  "${note}"`));
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
      cerr(`No task matching "${target}". Run: pensieve tasks`);
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
        cerr(`No session matching "${id}". Run: pensieve sessions`);
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
      cerr(`No session matching "${target}". Run: pensieve sessions --all`);
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
      cerr(`No session matching "${target}". Run: pensieve sessions`);
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
        cerr(`No memory matching "${id}". Run: pensieve memories`);
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
      cerr(`No memory matching "${id}". Run: pensieve memories`);
      process.exit(1);
    }
    const mid = String(match["id"]);
    await conn.query(`MATCH (m:Memory {id: '${esc(mid)}'}) DETACH DELETE m`);
    console.log(`${chalk.red("Removed")} memory ${chalk.dim(mid.slice(0, 8))}: ${chalk.white(String(match["title"]))}`);
  });

// ── Walk ─────────────────────────────────────────────────────────────────────

program
  .command("walk [sessionId]")
  .description("Walk session history forward or backward from a starting point")
  .option("-d, --direction <dir>", "forward, backward, or both", "backward")
  .option("-n, --steps <n>", "Number of steps to walk", "3")
  .action(async (sessionId: string | undefined, opts: { direction: string; steps: string }) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;
    const { escape: esc } = await import("./kuzu-helpers.js");

    const steps = Math.max(1, parseInt(opts.steps ?? "3", 10));
    const dir = (opts.direction ?? "backward").toLowerCase();

    // Fetch all sessions for project in chronological order
    const allRows = await queryAll(conn,
      `MATCH (p:Project {id: '${esc(pid)}'})-[:HAS_SESSION]->(s:Session)
       RETURN s ORDER BY s.startedAt ASC`);
    const allSessions = allRows.map((r) => r["s"] as Record<string, unknown>);

    if (allSessions.length === 0) {
      console.log(chalk.dim("No sessions found."));
      return;
    }

    // Resolve seed session
    let seedIdx: number;
    if (sessionId) {
      seedIdx = allSessions.findIndex((s) => String(s["id"]).includes(sessionId));
      if (seedIdx === -1) {
        cerr(`No session matching "${sessionId}". Run: pensieve sessions`);
        process.exit(1);
      }
    } else {
      seedIdx = allSessions.length - 1; // most recent
    }

    // Slice the walk range
    let walkSessions: Array<Record<string, unknown>>;
    if (dir === "forward") {
      walkSessions = allSessions.slice(seedIdx, seedIdx + steps + 1);
    } else if (dir === "both") {
      const back = allSessions.slice(Math.max(0, seedIdx - steps), seedIdx);
      const fwd = allSessions.slice(seedIdx + 1, seedIdx + steps + 1);
      walkSessions = [...back, allSessions[seedIdx], ...fwd];
    } else {
      // backward (default): seed + N sessions before it
      walkSessions = allSessions.slice(Math.max(0, seedIdx - steps), seedIdx + 1);
    }

    console.log(`\n${chalk.bold.cyan("── Walk")} ${chalk.dim("(" + dir + ", " + steps + " steps)")}\n`);

    for (const s of walkSessions) {
      const sid = String(s["id"]);
      const isSeed = sid === String(allSessions[seedIdx]["id"]);
      const ts = s["startedAt"] ? new Date(String(s["startedAt"])).toLocaleString() : "unknown";
      const marker = isSeed ? chalk.bold.white(" ← seed") : "";
      console.log(`${chalk.bold.cyan("──")} ${chalk.dim("[" + sessionShortId(sid) + "]")} ${chalk.white(String(s["title"] ?? "(untitled)"))}${marker}`);
      console.log(`   ${chalk.dim(ts)}`);
      if (s["summary"]) console.log(`   ${chalk.dim(String(s["summary"]).slice(0, 160) + (String(s["summary"]).length > 160 ? "…" : ""))}`);

      const memRows = await queryAll(conn,
        `MATCH (s:Session {id: '${esc(sid)}'})-[:HAS_MEMORY]->(m:Memory)
         RETURN m ORDER BY m.createdAt ASC`);
      if (memRows.length > 0) {
        for (const r of memRows) {
          const m = r["m"] as Record<string, unknown>;
          console.log(`   ${chalk.dim("[" + String(m["kind"] ?? "memory").toUpperCase() + "]")} ${String(m["title"] ?? "")}`);
        }
      }
      console.log();
    }
  });

// ── Diff ─────────────────────────────────────────────────────────────────────

program
  .command("diff [sessionA] [sessionB]")
  .description("Summarize what changed in the project's understanding between two sessions")
  .option("--last <n>", "Diff the last N sessions (default 2)", "2")
  .action(async (sessionA: string | undefined, sessionB: string | undefined, opts: { last: string }) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;
    const { escape: esc } = await import("./kuzu-helpers.js");

    const allRows = await queryAll(conn,
      `MATCH (p:Project {id: '${esc(pid)}'})-[:HAS_SESSION]->(s:Session)
       RETURN s ORDER BY s.startedAt ASC`);
    const allSessions = allRows.map((r) => r["s"] as Record<string, unknown>);

    if (allSessions.length < 2) {
      cerr("Need at least 2 sessions to diff.");
      process.exit(1);
    }

    let sA: Record<string, unknown>, sB: Record<string, unknown>;

    if (sessionA && sessionB) {
      const matchA = allSessions.find((s) => String(s["id"]).includes(sessionA));
      const matchB = allSessions.find((s) => String(s["id"]).includes(sessionB));
      if (!matchA) { cerr(`No session matching "${sessionA}".`); process.exit(1); }
      if (!matchB) { cerr(`No session matching "${sessionB}".`); process.exit(1); }
      sA = matchA;
      sB = matchB;
    } else {
      const n = Math.max(2, parseInt(opts.last ?? "2", 10));
      const slice = allSessions.slice(-n);
      sA = slice[0];
      sB = slice[slice.length - 1];
    }

    const fetchMemories = async (sid: string) => {
      const rows = await queryAll(conn,
        `MATCH (s:Session {id: '${esc(sid)}'})-[:HAS_MEMORY]->(m:Memory)
         RETURN m ORDER BY m.createdAt ASC`);
      return rows.map((r) => r["m"] as Record<string, unknown>);
    };

    const [memsA, memsB] = await Promise.all([
      fetchMemories(String(sA["id"])),
      fetchMemories(String(sB["id"])),
    ]);

    const formatMems = (mems: Array<Record<string, unknown>>) =>
      mems.length === 0
        ? "  (no memories)"
        : mems.map((m) => `  [${String(m["kind"] ?? "memory").toUpperCase()}] ${String(m["title"] ?? "")} — ${String(m["summary"] ?? "").slice(0, 100)}`).join("\n");

    const tsA = sA["startedAt"] ? new Date(String(sA["startedAt"])).toLocaleString() : "unknown";
    const tsB = sB["startedAt"] ? new Date(String(sB["startedAt"])).toLocaleString() : "unknown";

    // Header with raw delta
    const added = memsB.filter((b) => !memsA.some((a) => String(a["id"]) === String(b["id"]))).length;
    const removed = memsA.filter((a) => !memsB.some((b) => String(b["id"]) === String(a["id"]))).length;
    console.log(`\n${chalk.bold.cyan("── Diff")}`);
    console.log(`  ${chalk.dim("A:")} ${chalk.white(String(sA["title"] ?? "(untitled)"))}  ${chalk.dim(tsA)}`);
    console.log(`  ${chalk.dim("B:")} ${chalk.white(String(sB["title"] ?? "(untitled)"))}  ${chalk.dim(tsB)}`);
    console.log(`  ${chalk.dim("delta:")} ${chalk.green("+" + added)} memories  ${chalk.red("-" + removed)} memories\n`);

    process.stdout.write(chalk.dim("  [generating diff…]\n"));

    const prompt = `You are analyzing the evolution of a software project's knowledge base between two coding sessions.

Session A: "${String(sA["title"] ?? "untitled")}" (${tsA})
Memories from Session A:
${formatMems(memsA)}

Session B: "${String(sB["title"] ?? "untitled")}" (${tsB})
Memories from Session B:
${formatMems(memsB)}

Summarize what changed in the project's mental model between these two sessions.
Focus on: decisions made or revised, new facts discovered, tasks completed or added, open questions resolved or raised.
Be concise (3-6 bullet points). Do not list every memory — synthesize the meaningful changes.`;

    try {
      const summary = await llmComplete(prompt);
      console.log(chalk.white(summary));
    } catch (err) {
      cerr(`LLM error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    console.log();
  });

// ── Link ─────────────────────────────────────────────────────────────────────

const VALID_RELATIONS = ["refines", "supersedes", "contradicts", "caused_by", "resolves"] as const;

async function resolveMemoryByTitle(
  conn: InstanceType<(typeof import("kuzu"))["default"]["Connection"]>,
  pid: string,
  query: string,
  label: string
): Promise<Record<string, unknown>> {
  const { escape: esc } = await import("./kuzu-helpers.js");
  // If looks like an ID prefix (hex, short), try ID match first
  const isIdLike = /^[0-9a-f_-]{4,}$/i.test(query);
  if (isIdLike) {
    const rows = await queryAll(conn, `MATCH (m:Memory {projectId: '${esc(pid)}'}) RETURN m`);
    const byId = rows.map((r) => r["m"] as Record<string, unknown>).find((m) => String(m["id"]).includes(query));
    if (byId) return byId;
  }
  // Title substring search
  const rows = await queryAll(conn,
    `MATCH (m:Memory {projectId: '${esc(pid)}'})\
     WHERE toLower(m.title) CONTAINS toLower('${esc(query)}')\
     RETURN m ORDER BY m.createdAt DESC`);
  const matches = rows.map((r) => r["m"] as Record<string, unknown>);
  if (matches.length === 0) {
    cerr(`No memory found for ${label}: "${query}"`);
    process.exit(1);
  }
  if (matches.length === 1) return matches[0];
  // Ambiguous — print options and exit
  console.log(chalk.yellow(`Multiple memories match "${query}" for ${label}:`));
  matches.slice(0, 6).forEach((m, i) => {
    console.log(`  ${i + 1}.  [${String(m["kind"] ?? "memory").toUpperCase()}] ${chalk.white(String(m["title"] ?? ""))}  ${chalk.dim(shortId(String(m["id"])))}`);
  });
  cerr(`Be more specific. Re-run with a more precise title fragment.`);
  process.exit(1);
}

program
  .command("link <titleA> <titleB>")
  .description("Create an explicit semantic link between two Memory nodes")
  .option("-r, --relation <relation>", `Relation type: ${VALID_RELATIONS.join(", ")}`)
  .option("--note <note>", "Optional note about this link")
  .action(async (titleA: string, titleB: string, opts: { relation?: string; note?: string }) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;
    const { escape: esc } = await import("./kuzu-helpers.js");

    if (!opts.relation) {
      cerr(`--relation is required. Valid values: ${VALID_RELATIONS.join(", ")}`);
      process.exit(1);
    }
    if (!VALID_RELATIONS.includes(opts.relation as typeof VALID_RELATIONS[number])) {
      cerr(`Unknown relation "${opts.relation}". Valid values: ${VALID_RELATIONS.join(", ")}`);
      process.exit(1);
    }

    const [memA, memB] = await Promise.all([
      resolveMemoryByTitle(conn, pid, titleA, "A"),
      resolveMemoryByTitle(conn, pid, titleB, "B"),
    ]);

    const idA = String(memA["id"]);
    const idB = String(memB["id"]);

    if (idA === idB) {
      cerr("Cannot link a memory to itself.");
      process.exit(1);
    }

    // Check for duplicate
    const existing = await queryAll(conn,
      `MATCH (a:Memory {id: '${esc(idA)}'})-[r:LINKED]->(b:Memory {id: '${esc(idB)}'})\
       WHERE r.relation = '${esc(opts.relation)}' RETURN r`);
    if (existing.length > 0) {
      cerr(`A "${opts.relation}" link already exists between these memories.`);
      process.exit(1);
    }

    const now = new Date().toISOString();
    const note = opts.note ?? "";
    await conn.query(
      `MATCH (a:Memory {id: '${esc(idA)}'}), (b:Memory {id: '${esc(idB)}'})
       CREATE (a)-[:LINKED {relation: '${esc(opts.relation)}', createdAt: '${esc(now)}', note: '${esc(note)}', source: 'human', confidence: 1.0, sessionId: ''}]->(b)`
    );

    console.log(`${chalk.green("Linked")}  [${String(memA["kind"] ?? "memory").toUpperCase()}] ${chalk.white(String(memA["title"]))}  ${chalk.bold.cyan("─" + opts.relation + "→")}  [${String(memB["kind"] ?? "memory").toUpperCase()}] ${chalk.white(String(memB["title"]))}`);
  });

program
  .command("links [titleFragment]")
  .description("List explicit semantic links for a Memory node (or all recent links)")
  .action(async (titleFragment: string | undefined) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;
    const { escape: esc } = await import("./kuzu-helpers.js");

    if (!titleFragment) {
      // Show all recent links for this project
      const rows = await queryAll(conn,
        `MATCH (a:Memory {projectId: '${esc(pid)}'})-[r:LINKED]->(b:Memory)\
         RETURN a, r, b ORDER BY r.createdAt DESC LIMIT 20`);
      if (rows.length === 0) {
        console.log(chalk.dim("No links found. Create one with: pensieve link \"<titleA>\" \"<titleB>\" --relation <relation>"));
        return;
      }
      console.log(`\n${chalk.bold.cyan("── Recent Links")}\n`);
      for (const row of rows) {
        const a = row["a"] as Record<string, unknown>;
        const b = row["b"] as Record<string, unknown>;
        const r = row["r"] as Record<string, unknown>;
        const conf = Number(r["confidence"] ?? 1);
      const confTag = conf < 1 ? chalk.dim(` [${Math.round(conf * 100)}% confident]`) : "";
      const srcTag = String(r["source"] ?? "human") !== "human" ? chalk.dim(` [${r["source"]}]`) : "";
      console.log(`  ${chalk.dim(shortId(String(a["id"])))} [${String(a["kind"] ?? "memory").toUpperCase()}] ${chalk.white(String(a["title"]))}  ${chalk.bold.cyan("─" + String(r["relation"]) + "→")}  ${chalk.dim(shortId(String(b["id"])))} [${String(b["kind"] ?? "memory").toUpperCase()}] ${chalk.white(String(b["title"]))}${confTag}${srcTag}`);
        if (r["note"]) console.log(`    ${chalk.dim(String(r["note"]))}`);
      }
      console.log();
      return;
    }

    const mem = await resolveMemoryByTitle(conn, pid, titleFragment, "node");
    const mid = String(mem["id"]);

    const [outRows, inRows] = await Promise.all([
      queryAll(conn,
        `MATCH (a:Memory {id: '${esc(mid)}'})-[r:LINKED]->(b:Memory) RETURN r, b`),
      queryAll(conn,
        `MATCH (a:Memory)-[r:LINKED]->(b:Memory {id: '${esc(mid)}'}) RETURN r, a`),
    ]);

    console.log(`\n${chalk.bold.cyan("── Links for:")} ${chalk.white(String(mem["title"] ?? ""))}\n`);

    if (outRows.length === 0 && inRows.length === 0) {
      console.log(chalk.dim("  No links found."));
      console.log();
      return;
    }

    for (const row of outRows) {
      const b = row["b"] as Record<string, unknown>;
      const r = row["r"] as Record<string, unknown>;
      const rel = String(r["relation"]);
      const reverseLabel = rel === "contradicts" ? "↔" : "→";
      const conf = Number(r["confidence"] ?? 1);
      const meta = [
        conf < 1 ? `${Math.round(conf * 100)}% confident` : "",
        String(r["source"] ?? "human") !== "human" ? String(r["source"]) : "",
      ].filter(Boolean).join(", ");
      console.log(`  ${reverseLabel} ${chalk.bold.cyan(rel.padEnd(12))} ${chalk.dim(shortId(String(b["id"])))} [${String(b["kind"] ?? "memory").toUpperCase()}] ${chalk.white(String(b["title"] ?? ""))}${meta ? chalk.dim("  " + meta) : ""}`);
      if (r["note"]) console.log(`    ${chalk.dim(String(r["note"]))}`);
    }

    for (const row of inRows) {
      const a = row["a"] as Record<string, unknown>;
      const r = row["r"] as Record<string, unknown>;
      const rel = String(r["relation"]);
      if (rel === "contradicts") continue; // already shown as outgoing if symmetric
      const reverseLabel = `← ${rel} by`;
      const conf = Number(r["confidence"] ?? 1);
      const meta = [
        conf < 1 ? `${Math.round(conf * 100)}% confident` : "",
        String(r["source"] ?? "human") !== "human" ? String(r["source"]) : "",
      ].filter(Boolean).join(", ");
      console.log(`  ${chalk.dim(reverseLabel.padEnd(14))} ${chalk.dim(shortId(String(a["id"])))} [${String(a["kind"] ?? "memory").toUpperCase()}] ${chalk.white(String(a["title"] ?? ""))}${meta ? chalk.dim("  " + meta) : ""}`);
      if (r["note"]) console.log(`    ${chalk.dim(String(r["note"]))}`);
    }

    // Show incoming contradicts separately if not already shown outgoing
    for (const row of inRows) {
      const a = row["a"] as Record<string, unknown>;
      const r = row["r"] as Record<string, unknown>;
      if (String(r["relation"]) !== "contradicts") continue;
      const alreadyOut = outRows.some(
        (o) => String((o["b"] as Record<string, unknown>)["id"]) === String(a["id"]) && String((o["r"] as Record<string, unknown>)["relation"]) === "contradicts"
      );
      if (!alreadyOut) {
        console.log(`  ↔ ${"contradicts".padEnd(12)} ${chalk.dim(shortId(String(a["id"])))} [${String(a["kind"] ?? "memory").toUpperCase()}] ${chalk.white(String(a["title"] ?? ""))}`);
      }
    }

    console.log();
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
      console.log(`${chalk.bold("Usage:")} pensieve hook <type>\n`);
      console.log(chalk.bold("Available hook types:"));
      for (const [name, script] of Object.entries(HOOK_SCRIPTS)) {
        console.log(`  ${chalk.white(name.padEnd(16))} ${chalk.dim("(" + script + ")")}`);
      }
      console.log(chalk.dim("\nThese are registered automatically in .claude/settings.json and .github/settings.json"));
      console.log(chalk.dim("by running: pensieve init"));
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
