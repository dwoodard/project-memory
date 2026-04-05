import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { detectProject } from "./detect-project.js";
import { getDb, applySchema } from "./db.js";
import { DEFAULT_LLM, DEFAULT_EMBEDDING, type ProjectConfig } from "./config.js";

export async function initProject(cwd: string): Promise<void> {
  const detected = detectProject(cwd);
  if (!detected) {
    throw new Error("Not inside a git repository. Run git init first.");
  }

  const { repoRoot, remoteUrl, projectName } = detected;
  const projectMemoryDir = path.join(repoRoot, ".project-memory");
  const configPath = path.join(projectMemoryDir, "config.json");

  // Idempotent — check if already initialized
  if (fs.existsSync(configPath)) {
    const existing: ProjectConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
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
  const { conn } = getDb(projectMemoryDir);
  await applySchema(conn);

  // Write config with LLM defaults
  const projectId = `proj_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const config: ProjectConfig = {
    projectId,
    projectName,
    remoteUrl,
    repoPath: repoRoot,
    createdAt: new Date().toISOString(),
    llm: { ...DEFAULT_LLM },
    embedding: { ...DEFAULT_EMBEDDING },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Create Project node in Kuzu
  await conn.query(
    `CREATE (p:Project {
      id: '${projectId}',
      name: '${projectName.replace(/'/g, "\\'")}',
      remoteUrl: '${remoteUrl.replace(/'/g, "\\'")}',
      repoPath: '${repoRoot.replace(/'/g, "\\'")}',
      createdAt: '${config.createdAt}'
    })`
  );

  // Add .project-memory to .gitignore
  const gitignorePath = path.join(repoRoot, ".gitignore");
  const entry = ".project-memory/\n";
  if (fs.existsSync(gitignorePath)) {
    const contents = fs.readFileSync(gitignorePath, "utf-8");
    if (!contents.includes(".project-memory")) fs.appendFileSync(gitignorePath, `\n${entry}`);
  } else {
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

function writeClaudeSettings(repoRoot: string): void {
  const claudeDir = path.join(repoRoot, ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");
  fs.mkdirSync(claudeDir, { recursive: true });

  // The hook commands use "project-memory hook <type>" — portable, no hardcoded paths.
  // Requires project-memory to be on PATH (npm install -g project-memory).
  const hookEntry = (type: string) => ({
    matcher: "",
    hooks: [{ type: "command", command: `project-memory hook ${type}` }],
  });

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try { existing = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch { /* ignore */ }
  }

  // Merge — don't overwrite other settings the project may already have
  const hooks = (existing["hooks"] as Record<string, unknown[]> | undefined) ?? {};

  const upsertHook = (event: string, type: string) => {
    const entries = (hooks[event] as Array<{ hooks: Array<{ command: string }> }> | undefined) ?? [];
    const cmd = `project-memory hook ${type}`;
    const alreadyPresent = entries.some((e) => e.hooks?.some((h) => h.command === cmd));
    if (!alreadyPresent) entries.push(hookEntry(type));
    hooks[event] = entries;
  };

  upsertHook("SessionStart",     "session-start");
  upsertHook("UserPromptSubmit", "user-prompt");
  upsertHook("Stop",             "stop");
  upsertHook("PreCompact",       "compact");
  upsertHook("PostToolUse",      "post-tool-use");

  existing["hooks"] = hooks;
  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
}
