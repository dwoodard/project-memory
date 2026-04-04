export type MemoryKind =
  | "summary"
  | "decision"
  | "fact"
  | "reference"
  | "task"
  | "question";

export type TaskStatus = "pending" | "active" | "done" | "blocked";

export interface Project {
  id: string;
  name: string;
  remoteUrl: string;
  repoPath: string;
  createdAt: string;
}

export interface Session {
  id: string;
  projectId: string;
  startedAt: string;
  summary: string;
}

export interface Memory {
  id: string;
  kind: MemoryKind;
  title: string;
  summary: string;
  recallCue: string;
  projectId: string;
  sessionId: string;
  createdAt: string;
  status?: TaskStatus; // only for kind=task
  artifactId?: string;
}

export interface Artifact {
  id: string;
  type: string;
  title: string;
  summary: string;
  location: string;
  projectId: string;
  sessionId: string;
  createdAt: string;
}

export interface Turn {
  client: string;
  cwd: string;
  sessionId: string;
  timestamp: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  files?: string[];
}

export interface CandidateMemory {
  kind: MemoryKind;
  title: string;
  summary: string;
  recallCue: string;
  status?: TaskStatus;
}

export interface ProjectConfig {
  projectId: string;
  projectName: string;
  remoteUrl: string;
  repoPath: string;
  createdAt: string;
}

export interface ContextBundle {
  activeTask: Memory | null;
  nextTasks: Memory[];
  keyMemories: Memory[];
  sessionSummary: string;
}
