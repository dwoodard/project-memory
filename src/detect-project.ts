import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/** Walk up from startDir looking for a .pensieve/config.json — returns that dir or null */
export function findProjectRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, ".pensieve", "config.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Try to get git remote — optional enrichment, not required */
export function getRemoteUrl(dir: string): string | null {
  try {
    return execSync("git remote get-url origin", {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function resolveProjectIdentity(projectRoot: string): {
  remoteUrl?: string;
  projectName: string;
} {
  const projectName = path.basename(projectRoot);
  const remoteUrl = getRemoteUrl(projectRoot) ?? undefined;
  return { remoteUrl, projectName };
}

/** Find the nearest initialized pensieve project walking up from cwd */
export function detectProject(cwd: string): {
  projectRoot: string;
  remoteUrl?: string;
  projectName: string;
} | null {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return null;

  const { remoteUrl, projectName } = resolveProjectIdentity(projectRoot);
  return { projectRoot, remoteUrl, projectName };
}
