"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.findRepoRoot = findRepoRoot;
exports.getRemoteUrl = getRemoteUrl;
exports.getRepoName = getRepoName;
exports.resolveProjectIdentity = resolveProjectIdentity;
exports.detectProject = detectProject;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
function findRepoRoot(startDir) {
    let dir = startDir;
    while (true) {
        if (fs.existsSync(path.join(dir, ".git")))
            return dir;
        const parent = path.dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
function getRemoteUrl(repoRoot) {
    try {
        return (0, child_process_1.execSync)("git remote get-url origin", {
            cwd: repoRoot,
            stdio: ["pipe", "pipe", "pipe"],
        })
            .toString()
            .trim();
    }
    catch {
        return null;
    }
}
function getRepoName(repoRoot) {
    return path.basename(repoRoot);
}
function resolveProjectIdentity(repoRoot) {
    const remoteUrl = getRemoteUrl(repoRoot);
    const projectName = getRepoName(repoRoot);
    if (remoteUrl) {
        return { remoteUrl, projectName };
    }
    // No remote — check if we already generated a stable ID
    const configPath = path.join(repoRoot, ".project-memory", "config.json");
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        return { remoteUrl: config.remoteUrl, projectName: config.projectName };
    }
    // Generate a stable fallback ID
    const uuid = crypto.randomUUID();
    return {
        remoteUrl: `local://${projectName}-${uuid}`,
        projectName,
    };
}
function detectProject(cwd) {
    const repoRoot = findRepoRoot(cwd);
    if (!repoRoot)
        return null;
    const { remoteUrl, projectName } = resolveProjectIdentity(repoRoot);
    return { repoRoot, remoteUrl, projectName };
}
