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
import { getDb, applySchema } from "./db.js";
import { queryAll } from "./kuzu-helpers.js";
import {
  readProjectConfig,
  writeProjectConfig,
  PROVIDER_DEFAULTS,
  type ProjectConfig,
} from "./config.js";
import { embed } from "./llm.js";
import { searchMemories } from "./search.js";
import type { Turn } from "./types.js";

const program = new Command();

program
  .name("pensive")
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
        ".pensive"
      );
      const configPath = path.join(projectMemoryDir, "config.json");

      if (!fs.existsSync(configPath)) {
        console.error("Not initialized. Run: pensive init");
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

    const projectMemoryDir = path.join(detected.repoRoot, ".pensive");
    const configPath = path.join(projectMemoryDir, "config.json");

    if (!fs.existsSync(configPath)) {
      console.log("Not initialized. Run: pensive init");
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

program
  .command("search <query>")
  .description("Semantic search across memories, with graph context")
  .option("-k, --top <n>", "Number of results", "5")
  .action(async (query: string, opts) => {
    const detected = detectProject(process.cwd());
    if (!detected) { console.error("Not in a git repository."); process.exit(1); }

    const projectMemoryDir = path.join(detected.repoRoot, ".pensive");
    const config = readProjectConfig(projectMemoryDir);
    const { conn } = getDb(projectMemoryDir);

    const topK = parseInt(opts.top ?? "5", 10);
    const results = await searchMemories(conn, config.projectId, query, topK);

    if (results.length === 0) {
      console.log("No memories found.");
      return;
    }

    console.log(`\nQuery: "${query}"\n`);

    for (const m of results) {
      console.log(`── [${m.kind.toUpperCase()}] ${m.title}  (score: ${m.score.toFixed(4)})`);
      console.log(`   ${m.summary}`);

      // Parent session
      const sessRows = await queryAll(conn,
        `MATCH (s:Session)-[:HAS_MEMORY]->(m:Memory {id: '${m.id}'})
         RETURN s.title AS title, s.summary AS summary`
      );
      if (sessRows.length > 0) {
        const s = sessRows[0];
        const title = String(s.title || "untitled session");
        const snippet = String(s.summary ?? "").slice(0, 120);
        console.log(`\n   Session: ${title}`);
        if (snippet) console.log(`   ${snippet}${s.summary && String(s.summary).length > 120 ? "…" : ""}`);
      }

      // Sibling memories in same session
      const siblings = await queryAll(conn,
        `MATCH (s:Session {id: '${m.sessionId}'})-[:HAS_MEMORY]->(sib:Memory)
         WHERE sib.id <> '${m.id}'
         RETURN sib.kind AS kind, sib.title AS title`
      );
      if (siblings.length > 0) {
        console.log(`\n   Also from this session:`);
        siblings.forEach((s) => console.log(`     [${s.kind}] ${s.title}`));
      }

      console.log();
    }
  });

program
  .command("backfill-embeddings")
  .description("Generate and store embeddings for all Memory nodes that are missing them")
  .action(async () => {
    const detected = detectProject(process.cwd());
    if (!detected) { console.error("Not in a git repository."); process.exit(1); }

    const projectMemoryDir = path.join(detected.repoRoot, ".pensive");
    const config = readProjectConfig(projectMemoryDir);
    const { conn } = getDb(projectMemoryDir);

    const rows = await queryAll(
      conn,
      `MATCH (m:Memory {projectId: '${config.projectId}'})
       WHERE m.embedding IS NULL OR size(m.embedding) = 0
       RETURN m.id AS id, m.title AS title, m.summary AS summary`
    );

    if (rows.length === 0) {
      console.log("All Memory nodes already have embeddings.");
      return;
    }

    console.log(`Backfilling ${rows.length} memory node(s)...`);
    let done = 0, failed = 0;

    for (const row of rows) {
      const id = String(row["id"]);
      const text = `${row["title"]}. ${row["summary"]}`;
      try {
        const embedding = await embed(text);
        const literal = `[${embedding.join(", ")}]`;
        await conn.query(
          `MATCH (m:Memory {id: '${id}'}) SET m.embedding = ${literal}`
        );
        done++;
        process.stdout.write(`\r  ${done}/${rows.length} embedded, ${failed} failed`);
      } catch (err) {
        failed++;
        process.stdout.write(`\r  ${done}/${rows.length} embedded, ${failed} failed`);
      }
    }

    console.log(`\nDone. ${done} embedded, ${failed} failed.`);
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

    const projectMemoryDir = path.join(detected.repoRoot, ".pensive");
    const configPath = path.join(projectMemoryDir, "config.json");

    if (!fs.existsSync(configPath)) {
      console.error("Not initialized. Run: pensive init");
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
    const projectMemoryDir = path.join(detected.repoRoot, ".pensive");
    const configPath = path.join(projectMemoryDir, "config.json");
    if (!fs.existsSync(configPath)) {
      console.error("Not initialized. Run: pensive init");
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

    console.log(`\nSaved to .pensive/config.json`);
    console.log(`  LLM:       ${llmProvider} / ${llmModel}`);
    console.log(`  Embedding: ${embProvider} / ${embModel}`);
  });

// ── Tasks ────────────────────────────────────────────────────────────────────

async function getProjectDb(cwd: string) {
  const detected = detectProject(cwd);
  if (!detected) {
    console.error("Not in a git repository.");
    process.exit(1);
  }
  const projectMemoryDir = path.join(detected.repoRoot, ".pensive");
  const configPath = path.join(projectMemoryDir, "config.json");
  if (!fs.existsSync(configPath)) {
    console.error("Not initialized. Run: pensive init");
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

function printTaskList(
  active: Record<string, unknown> | undefined,
  pending: Record<string, unknown>[],
  blocked: Record<string, unknown>[],
  done: Record<string, unknown>[]
): void {
  if (!active && pending.length === 0 && blocked.length === 0 && done.length === 0) {
    console.log("No tasks. Add one: pensive tasks add \"title\"");
    return;
  }

  if (active) {
    console.log(`\n● ACTIVE   ${active["title"]}`);
    if (active["summary"]) console.log(`           ${active["summary"]}`);
  } else {
    console.log("\n  (no active task)");
  }

  if (pending.length > 0) {
    console.log("\n  QUEUE");
    pending.forEach((t, i) =>
      console.log(`  ${String(i + 1).padStart(2)}  [${shortId(String(t["id"]))}]  ${t["title"]}`)
    );
  }

  if (blocked.length > 0) {
    console.log("\n  BLOCKED");
    blocked.forEach((t) =>
      console.log(`  ✗  [${shortId(String(t["id"]))}]  ${t["title"]}`)
    );
  }

  if (done.length > 0) {
    console.log("\n  DONE");
    done.forEach((t) => console.log(`  ✓  ${t["title"]}`));
  }

  console.log("");
}

const tasksCmd = program
  .command("tasks")
  .description("Manage project tasks");

// Default action: list all tasks
tasksCmd
  .option("--all", "Show all done tasks, not just the last 10")
  .action(async () => {
    const opts = tasksCmd.opts();
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;

    const activeRows = await queryAll(conn,
      `MATCH (m:Task {projectId: '${pid}', status: 'active'})
       RETURN m ORDER BY m.createdAt DESC LIMIT 1`);
    const pendingRows = await queryAll(conn,
      `MATCH (m:Task {projectId: '${pid}', status: 'pending'})
       RETURN m ORDER BY m.taskOrder ASC`);
    const blockedRows = await queryAll(conn,
      `MATCH (m:Task {projectId: '${pid}', status: 'blocked'})
       RETURN m ORDER BY m.createdAt DESC`);
    if (opts.all) {
      const allRows = await queryAll(conn,
        `MATCH (t:Task {projectId: '${pid}'}) RETURN t ORDER BY t.taskOrder ASC, t.createdAt ASC`);
      const statusOrder = ["active", "pending", "blocked", "done"];
      const all = allRows
        .map((r) => r["t"] as Record<string, unknown>)
        .sort((a, b) => statusOrder.indexOf(String(a["status"])) - statusOrder.indexOf(String(b["status"])));
      if (all.length === 0) {
        console.log("No tasks.");
      } else {
        all.forEach((t) =>
          console.log(`  [${shortId(String(t["id"]))}]  ${String(t["status"]).padEnd(8)}  ${t["title"]}`)
        );
      }
      return;
    }

    const doneRows = await queryAll(conn,
      `MATCH (m:Task {projectId: '${pid}', status: 'done'})
       RETURN m ORDER BY m.createdAt DESC LIMIT 10`);

    printTaskList(
      activeRows[0]?.["m"] as Record<string, unknown> | undefined,
      pendingRows.map((r) => r["m"] as Record<string, unknown>),
      blockedRows.map((r) => r["m"] as Record<string, unknown>),
      doneRows.map((r) => r["m"] as Record<string, unknown>)
    );
  });

tasksCmd
  .command("add <title>")
  .description("Add a task to the queue")
  .action(async (title: string) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;

    const orderRows = await queryAll(conn,
      `MATCH (m:Task {projectId: '${pid}', status: 'pending'})
       RETURN max(m.taskOrder) AS maxOrder`);
    const maxOrder = Number(orderRows[0]?.["maxOrder"] ?? 0);
    const taskOrder = maxOrder + 1;

    const { escape: esc } = await import("./kuzu-helpers.js");
    const { default: crypto } = await import("crypto");
    const id = `task_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

    await conn.query(
      `CREATE (t:Task {
        id: '${esc(id)}',
        title: '${esc(title)}',
        summary: '',
        status: 'pending',
        taskOrder: ${taskOrder},
        projectId: '${esc(pid)}',
        createdAt: '${new Date().toISOString()}'
      })`
    );

    await conn.query(
      `MATCH (p:Project {id: '${esc(pid)}'}), (t:Task {id: '${esc(id)}'})
       CREATE (p)-[:HAS_TASK]->(t)`
    );

    console.log(`Added: ${title}  [${shortId(id)}]`);
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
    const pos = parseInt(target, 10);
    if (!isNaN(pos) && pos >= 1 && pos <= pending.length) {
      target_id = String(pending[pos - 1]["id"]);
    } else {
      const match = pending.find((t) => String(t["id"]).includes(target));
      target_id = match ? String(match["id"]) : undefined;
    }

    if (!target_id) {
      console.error(`No pending task matching "${target}". Run: pensive tasks`);
      process.exit(1);
    }

    // Demote any currently active task
    await conn.query(
      `MATCH (m:Task {projectId: '${esc(pid)}', status: 'active'})
       SET m.status = 'pending'`
    );
    await conn.query(
      `MATCH (m:Task {id: '${esc(target_id)}'}) SET m.status = 'active'`
    );

    const title = pending.find((t) => String(t["id"]) === target_id)?.["title"];
    console.log(`Active: ${title}`);
  });

tasksCmd
  .command("done")
  .description("Mark the active task as done")
  .action(async () => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;

    const rows = await queryAll(conn,
      `MATCH (m:Task {projectId: '${pid}', status: 'active'})
       RETURN m LIMIT 1`);
    if (rows.length === 0) {
      console.log("No active task.");
      return;
    }

    const { escape: esc } = await import("./kuzu-helpers.js");
    const task = rows[0]["m"] as Record<string, unknown>;
    await conn.query(
      `MATCH (m:Task {id: '${esc(String(task["id"]))}' }) SET m.status = 'done'`
    );
    console.log(`Done: ${task["title"]}`);

    // Show next pending task as a reminder
    const next = await queryAll(conn,
      `MATCH (m:Task {projectId: '${pid}', status: 'pending'})
       RETURN m ORDER BY m.taskOrder ASC LIMIT 1`);
    if (next.length > 0) {
      const n = next[0]["m"] as Record<string, unknown>;
      console.log(`Next up: ${n["title"]}  — run: pensive tasks start 1`);
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
      console.log("No active task.");
      return;
    }

    const { escape: esc } = await import("./kuzu-helpers.js");
    const task = rows[0]["m"] as Record<string, unknown>;
    const newSummary = `Blocked: ${reason}\n${task["summary"] ?? ""}`.trim();
    await conn.query(
      `MATCH (m:Task {id: '${esc(String(task["id"]))}' })
       SET m.status = 'blocked', m.summary = '${esc(newSummary)}'`
    );
    console.log(`Blocked: ${task["title"]}`);
    console.log(`Reason:  ${reason}`);
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
      if (!ok) { console.log("Cancelled."); return; }
      const rows = await queryAll(conn, `MATCH (t:Task {projectId: '${pid}'}) RETURN count(t) AS cnt`);
      const cnt = Number(rows[0]?.["cnt"] ?? 0);
      await conn.query(`MATCH (t:Task {projectId: '${pid}'}) DETACH DELETE t`);
      console.log(`Removed ${cnt} task(s).`);
      return;
    }

    if (!target) {
      console.error("Specify a task position or id, or use --all.");
      process.exit(1);
    }

    const allRows = await queryAll(conn,
      `MATCH (t:Task {projectId: '${pid}'})
       WHERE t.status <> 'done'
       RETURN t ORDER BY t.taskOrder ASC`);
    const all = allRows.map((r) => r["t"] as Record<string, unknown>);

    let targetId: string | undefined;
    const pos = parseInt(target, 10);
    if (!isNaN(pos) && pos >= 1 && pos <= all.length) {
      targetId = String(all[pos - 1]["id"]);
    } else {
      const match = all.find((t) => String(t["id"]).includes(target));
      targetId = match ? String(match["id"]) : undefined;
    }

    if (!targetId) {
      console.error(`No task matching "${target}". Run: pensive tasks`);
      process.exit(1);
    }

    const task = all.find((t) => String(t["id"]) === targetId);
    await conn.query(`MATCH (t:Task {id: '${esc(targetId)}'}) DETACH DELETE t`);
    console.log(`Removed: ${task?.["title"]}`);
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
      console.error(`Positions must be between 1 and ${pending.length}`);
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

    console.log("Queue reordered:");
    pending.forEach((t, i) =>
      console.log(`  ${i + 1}  ${t["title"]}`)
    );
  });

// ── Sessions ─────────────────────────────────────────────────────────────────

const sessionsCmd = program
  .command("sessions")
  .description("Manage project sessions");

sessionsCmd
  .action(async () => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;
    const rows = await queryAll(conn,
      `MATCH (s:Session {projectId: '${pid}'})
       RETURN s ORDER BY s.startedAt DESC`);
    if (rows.length === 0) {
      console.log("No sessions.");
      return;
    }
    rows.forEach((r) => {
      const s = r["s"] as Record<string, unknown>;
      const ts = s["startedAt"] ? new Date(String(s["startedAt"])).toLocaleString() : "unknown";
      const title = s["title"] ? `  ${s["title"]}` : "";
      console.log(`  [${shortId(String(s["id"]))}]  ${ts}${title}`);
    });
  });

sessionsCmd
  .command("remove [target]")
  .description("Remove a session by id prefix; --all removes every session and its memories")
  .option("--all", "Remove all sessions (and their memories/artifacts) for this project")
  .action(async (target: string | undefined, opts: { all?: boolean }) => {
    const { config, conn } = await getProjectDb(process.cwd());
    const pid = config.projectId;
    const { escape: esc } = await import("./kuzu-helpers.js");

    if (opts.all) {
      const { confirm } = await import("@inquirer/prompts");
      const ok = await confirm({ message: "Remove all sessions, memories, and artifacts for this project?", default: false });
      if (!ok) { console.log("Cancelled."); return; }
      const mRows = await queryAll(conn, `MATCH (m:Memory {projectId: '${pid}'}) RETURN count(m) AS cnt`);
      const aRows = await queryAll(conn, `MATCH (a:Artifact {projectId: '${pid}'}) RETURN count(a) AS cnt`);
      const sRows = await queryAll(conn, `MATCH (s:Session {projectId: '${pid}'}) RETURN count(s) AS cnt`);
      await conn.query(`MATCH (m:Memory {projectId: '${pid}'}) DETACH DELETE m`);
      await conn.query(`MATCH (a:Artifact {projectId: '${pid}'}) DETACH DELETE a`);
      await conn.query(`MATCH (s:Session {projectId: '${pid}'}) DETACH DELETE s`);
      const sc = Number(sRows[0]?.["cnt"] ?? 0);
      const mc = Number(mRows[0]?.["cnt"] ?? 0);
      const ac = Number(aRows[0]?.["cnt"] ?? 0);
      console.log(`Removed ${sc} session(s), ${mc} memory node(s), ${ac} artifact(s).`);
      return;
    }

    if (!target) {
      console.error("Specify a session id prefix, or use --all.");
      process.exit(1);
    }

    const rows = await queryAll(conn,
      `MATCH (s:Session {projectId: '${pid}'}) RETURN s`);
    const sessions = rows.map((r) => r["s"] as Record<string, unknown>);
    const match = sessions.find((s) => String(s["id"]).includes(target));
    if (!match) {
      console.error(`No session matching "${target}". Run: pensive sessions`);
      process.exit(1);
    }
    const sid = String(match["id"]);
    await conn.query(`MATCH (m:Memory {sessionId: '${esc(sid)}'}) DETACH DELETE m`);
    await conn.query(`MATCH (a:Artifact {sessionId: '${esc(sid)}'}) DETACH DELETE a`);
    await conn.query(`MATCH (s:Session {id: '${esc(sid)}'}) DETACH DELETE s`);
    console.log(`Removed session [${shortId(sid)}] and its memories/artifacts.`);
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
      console.log("Usage: pensive hook <type>\n");
      console.log("Available hook types:");
      for (const [name, script] of Object.entries(HOOK_SCRIPTS)) {
        console.log(`  ${name.padEnd(16)} (${script})`);
      }
      console.log("\nThese are registered automatically in .claude/settings.json and .github/settings.json");
      console.log("by running: pensive init");
      process.exit(0);
    }
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
