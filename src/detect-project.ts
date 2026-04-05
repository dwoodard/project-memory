import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { ProjectConfig } from "./config.js";

export function findRepoRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function getRemoteUrl(repoRoot: string): string | null {
  try {
    return execSync("git remote get-url origin", {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function getRepoName(repoRoot: string): string {
  return path.basename(repoRoot);
}

export function resolveProjectIdentity(repoRoot: string): {
  remoteUrl: string;
  projectName: string;
} {
  const remoteUrl = getRemoteUrl(repoRoot);
  const projectName = getRepoName(repoRoot);

  if (remoteUrl) {
    return { remoteUrl, projectName };
  }

  // No remote — check if we already generated a stable ID
  const configPath = path.join(repoRoot, ".project-memory", "config.json");
  if (fs.existsSync(configPath)) {
    const config: ProjectConfig = JSON.parse(
      fs.readFileSync(configPath, "utf-8")
    );
    return { remoteUrl: config.remoteUrl, projectName: config.projectName };
  }

  // Generate a stable fallback ID
  const uuid = crypto.randomUUID();
  return {
    remoteUrl: `local://${projectName}-${uuid}`,
    projectName,
  };
}

export function detectProject(cwd: string): {
  repoRoot: string;
  remoteUrl: string;
  projectName: string;
} | null {
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) return null;

  const { remoteUrl, projectName } = resolveProjectIdentity(repoRoot);
  return { repoRoot, remoteUrl, projectName };
}
