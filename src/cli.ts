import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { initProject } from "./init.js";
import { ingestTurn } from "./index.js";
import { assembleContext, formatContextBundle } from "./assemble-context.js";
import { detectProject } from "./detect-project.js";
import { getDb } from "./db.js";
import { readSummary } from "./update-summary.js";
import type { Turn, ProjectConfig } from "./types.js";

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

      // Use today's session summary if available
      const today = new Date().toISOString().slice(0, 10);
      const sessionId = `${config.projectId}_${today}`;
      const summary = readSummary(projectMemoryDir, sessionId);

      const bundle = await assembleContext(config.projectId, summary, conn);
      console.log(formatContextBundle(bundle));
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
  .action(() => {
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

    const config: ProjectConfig = JSON.parse(
      fs.readFileSync(configPath, "utf-8")
    );
    console.log(`Project: ${config.projectName}`);
    console.log(`ID:      ${config.projectId}`);
    console.log(`Remote:  ${config.remoteUrl}`);
    console.log(`Path:    ${projectMemoryDir}`);
  });

program.parse(process.argv);
