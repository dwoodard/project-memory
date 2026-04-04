import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { detectProject } from "./detect-project.js";
import { getDb, applySchema } from "./db.js";
import type { ProjectConfig } from "./types.js";

export async function initProject(cwd: string): Promise<void> {
  const detected = detectProject(cwd);
  if (!detected) {
    throw new Error("Not inside a git repository. Run git init first.");
  }

  const { repoRoot, remoteUrl, projectName } = detected;
  const projectMemoryDir = path.join(repoRoot, ".project-memory");

  // Idempotent — check if already initialized
  const configPath = path.join(projectMemoryDir, "config.json");
  if (fs.existsSync(configPath)) {
    const existing: ProjectConfig = JSON.parse(
      fs.readFileSync(configPath, "utf-8")
    );
    console.log(
      `Already initialized: ${existing.projectName} (${existing.projectId})`
    );
    return;
  }

  // Create directory structure
  const dirs = [
    projectMemoryDir,
    path.join(projectMemoryDir, "sessions"),
    path.join(projectMemoryDir, "candidates"),
    path.join(projectMemoryDir, "artifacts"),
    path.join(projectMemoryDir, "summaries"),
    path.join(projectMemoryDir, "queue"),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Initialize Kuzu and apply schema
  const { conn } = getDb(projectMemoryDir);
  await applySchema(conn);

  // Write config
  const projectId = `proj_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const config: ProjectConfig = {
    projectId,
    projectName,
    remoteUrl,
    repoPath: repoRoot,
    createdAt: new Date().toISOString(),
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
    if (!contents.includes(".project-memory")) {
      fs.appendFileSync(gitignorePath, `\n${entry}`);
    }
  } else {
    fs.writeFileSync(gitignorePath, entry);
  }

  console.log(`Initialized project: ${projectName}`);
  console.log(`  ID:     ${projectId}`);
  console.log(`  Remote: ${remoteUrl}`);
  console.log(`  Path:   ${projectMemoryDir}`);
}
