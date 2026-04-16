import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawnSync } from "child_process";
import { resolveProjectIdentity } from "./detect-project.js";
import { getDb, applySchema } from "./db.js";
import { DEFAULT_LLM, DEFAULT_EMBEDDING, type ProjectConfig } from "./config.js";

function checkDependencies(): string[] {
  const missing: string[] = [];
  const dependencies = ["gh"]; // gh CLI required for GitHub integration

  dependencies.forEach((cmd) => {
    const result = spawnSync("which", [cmd], { stdio: "pipe" });
    if (result.status !== 0) {
      missing.push(cmd);
    }
  });

  return missing;
}

export async function initProject(cwd: string): Promise<boolean> {
  // Use cwd directly as the project root — no git required
  const projectRoot = cwd;
  const { remoteUrl, projectName } = resolveProjectIdentity(projectRoot);
  const repoRoot = projectRoot;
  const projectMemoryDir = path.join(projectRoot, ".pensieve");
  const configPath = path.join(projectMemoryDir, "config.json");

  // Idempotent — check if already initialized
  if (fs.existsSync(configPath)) {
    const existing: ProjectConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    console.log(`Already initialized: ${existing.projectName}`);
    console.log(`  ID:   ${existing.projectId}`);
    console.log(`  Path: ${repoRoot}`);
    return false;
  }

  // Create directory structure
  for (const dir of [
    projectMemoryDir,
    path.join(projectMemoryDir, "sessions"),
    path.join(projectMemoryDir, "candidates"),
    path.join(projectMemoryDir, "summaries"),
    path.join(projectMemoryDir, "queue"),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Initialize Kuzu and apply schema
  const { conn } = await getDb(projectMemoryDir);
  await applySchema(conn);

  // Write config with LLM defaults
  const projectId = `proj_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const config: ProjectConfig = {
    projectId,
    projectName,
    ...(remoteUrl ? { remoteUrl } : {}),
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
      ${remoteUrl ? `remoteUrl: '${remoteUrl.replace(/'/g, "\\'")}',` : ""}
      repoPath: '${repoRoot.replace(/'/g, "\\'")}',
      createdAt: '${config.createdAt}'
    })`
  );

  // Add .pensieve to .gitignore only if this is a git repo
  const gitDir = path.join(repoRoot, ".git");
  if (fs.existsSync(gitDir)) {
    const gitignorePath = path.join(repoRoot, ".gitignore");
    const entry = ".pensieve/\n";
    if (fs.existsSync(gitignorePath)) {
      const contents = fs.readFileSync(gitignorePath, "utf-8");
      if (!contents.includes(".pensieve")) fs.appendFileSync(gitignorePath, `\n${entry}`);
    } else {
      fs.writeFileSync(gitignorePath, entry);
    }
  }

  // Write hook registrations and slash commands
  writeClaudeSettings(projectRoot);
  writeSlashCommands(projectRoot, false);

  console.log(`Initialized project: ${projectName}`);
  console.log(`  ID:     ${projectId}`);
  if (remoteUrl) console.log(`  Remote: ${remoteUrl}`);
  console.log(`  Path:   ${projectMemoryDir}`);
  console.log(`  Hooks:  .claude/settings.json`);
  console.log(`  Cmds:   .claude/commands/pensieve-{search,recall,log,file,task,walk,diff}.md`);
  console.log(`  Run "pensieve config" to set your LLM and embedding models.`);

  // Check for required dependencies
  const missing = checkDependencies();
  if (missing.length > 0) {
    console.log(`\n  ⚠️  Missing dependencies (required for GitHub integration):`);
    missing.forEach((cmd) => {
      console.log(`    - ${cmd}: install with 'brew install gh' or see https://cli.github.com`);
    });
  }

  return true;
}

export function updateProject(cwd: string, force: boolean): void {
  const projectRoot = cwd;
  const configPath = path.join(projectRoot, ".pensieve", "config.json");

  if (!fs.existsSync(configPath)) {
    console.error("Not a pensieve project. Run 'pensieve init' first.");
    process.exit(1);
  }

  const config: ProjectConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  console.log(`Updating: ${config.projectName}`);

  writeClaudeSettings(projectRoot);
  console.log("  ✓ hooks (.claude/settings.json)");

  const { written, skipped } = writeSlashCommands(projectRoot, force);
  for (const name of written) console.log(`  ✓ .claude/commands/${name}.md`);
  for (const name of skipped) console.log(`  ~ .claude/commands/${name}.md (skipped — already exists, use --force to overwrite)`);
}

const HOOK_EVENTS: Array<[event: string, type: string]> = [
  ["SessionStart",     "session-start"],
  ["UserPromptSubmit", "user-prompt"],
  ["Stop",             "stop"],
  ["PreCompact",       "compact"],
  ["PostToolUse",      "post-tool-use"],
];

/** .claude/settings.json — nested format expected by Claude Code */
function writeClaudeSettings(projectRoot: string): void {
  const claudeDir = path.join(projectRoot, ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");
  fs.mkdirSync(claudeDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try { existing = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch { /* ignore */ }
  }

  const hooks = (existing["hooks"] as Record<string, unknown[]> | undefined) ?? {};

  for (const [event, type] of HOOK_EVENTS) {
    const cmd = `pensieve hook ${type}`;
    const entries = (hooks[event] as Array<Record<string, unknown>> | undefined) ?? [];
    const alreadyPresent = entries.some((e) => {
      const inner = e["hooks"] as Array<Record<string, unknown>> | undefined;
      return Array.isArray(inner) && inner.some((h) => h["command"] === cmd);
    });
    if (!alreadyPresent) {
      entries.push({ matcher: "", hooks: [{ type: "command", command: cmd }] });
    }
    hooks[event] = entries;
  }

  existing["hooks"] = hooks;
  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
}

const SLASH_COMMANDS: Array<[name: string, content: string]> = [
  [
    "pensieve-search",
    `Run this command and incorporate the results into your response:

\`\`\`bash
pensieve search "$ARGUMENTS"
\`\`\`

Review the output carefully. Surface any relevant prior decisions, patterns, or context that apply to what we're working on. If results are thin, say so briefly and continue.
`,
  ],
  [
    "pensieve-recall",
    `Load the full project memory context by running:

\`\`\`bash
pensieve context
\`\`\`

Read the output and give a brief summary of the most relevant memories, active tasks, and recent session context. Focus on what's directly useful for our current conversation.
`,
  ],
  [
    "pensieve-log",
    `Log the following decision or insight to memory: $ARGUMENTS

State it clearly in your response in this format so pensieve captures it at session end:

> **Logged:** [restate the key decision or insight in one or two sentences]

Then run:

\`\`\`bash
pensieve search "$ARGUMENTS"
\`\`\`

to surface any related prior context that's already stored.
`,
  ],
  [
    "pensieve-file",
    `Find prior work and context related to this file:

\`\`\`bash
pensieve search --file $ARGUMENTS
\`\`\`

Review the output and summarize: which sessions touched this file, what decisions were made, and any patterns or gotchas relevant to working with it now.
`,
  ],
  [
    "pensieve-task",
    `Show the current active task and queue:

\`\`\`bash
pensieve tasks
\`\`\`

Summarize the active task, what's been done toward it, and what's next in the queue. If no task is active, suggest starting the first queued item.
`,
  ],
  [
    "pensieve-walk",
    `Walk session history to catch up on prior work related to: $ARGUMENTS

\`\`\`bash
pensieve walk --direction both --steps 4
\`\`\`

Summarize what was discovered, decided, or built across these sessions. Focus on anything directly relevant to what we're working on now.
`,
  ],
  [
    "pensieve-diff",
    `Summarize what changed in the project's understanding between two sessions: $ARGUMENTS

\`\`\`bash
pensieve diff $ARGUMENTS
\`\`\`

Review the diff output and explain in plain terms what shifted — new decisions made, old assumptions invalidated, scope added or removed.
`,
  ],
];

/** .claude/commands/pensieve-*.md — custom slash commands for Claude Code */
function writeSlashCommands(projectRoot: string, force: boolean): { written: string[]; skipped: string[] } {
  const commandsDir = path.join(projectRoot, ".claude", "commands");
  fs.mkdirSync(commandsDir, { recursive: true });

  const written: string[] = [];
  const skipped: string[] = [];

  for (const [name, content] of SLASH_COMMANDS) {
    const filePath = path.join(commandsDir, `${name}.md`);
    if (force || !fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content);
      written.push(name);
    } else {
      skipped.push(name);
    }
  }

  return { written, skipped };
}

/** .github/hooks/pensieve.json — flat format */
function writeGithubHooks(projectRoot: string): void {
  const hooksDir = path.join(projectRoot, ".github", "hooks");
  const pensievePath = path.join(hooksDir, "pensieve.json");
  fs.mkdirSync(hooksDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(pensievePath)) {
    try { existing = JSON.parse(fs.readFileSync(pensievePath, "utf-8")); } catch { /* ignore */ }
  }

  const hooks = (existing["hooks"] as Record<string, unknown[]> | undefined) ?? {};

  for (const [event, type] of HOOK_EVENTS) {
    const cmd = `pensieve hook ${type}`;
    const entries = (hooks[event] as Array<Record<string, string>> | undefined) ?? [];
    const alreadyPresent = entries.some((e) => e["command"] === cmd);
    if (!alreadyPresent) {
      entries.push({ matcher: "", type: "command", command: cmd });
    }
    hooks[event] = entries;
  }

  existing["hooks"] = hooks;
  fs.writeFileSync(pensievePath, JSON.stringify(existing, null, 2));
}
