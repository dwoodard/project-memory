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
  description?: string;
}

export interface Session {
  id: string;
  projectId: string;
  startedAt: string;
  title: string;
  summary: string;
  archived?: boolean;
  embedding?: number[];
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
  embedding?: number[];
}

export interface Task {
  id: string;
  title: string;
  summary: string;
  status: TaskStatus;
  taskOrder: number;
  projectId: string;
  createdAt: string;
  parentId?: string;
  completedAt?: string;
  completionNote?: string;
  doneSuggestion?: string;
  embedding?: number[];
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

/** Kuzu graph node representing a stored conversation turn */
export interface TurnNode {
  id: string;          // turnId from JSONL
  sessionId: string;
  projectId: string;
  timestamp: string;
  userText: string;    // first 400 chars of user message
  assistantText: string; // first 400 chars of assistant message
  embedding?: number[];
}

/** Kuzu graph node representing a source file referenced in a turn */
export interface ProjectFile {
  id: string;          // "{projectId}:{path}"
  path: string;        // relative to project root
  projectId: string;
  language: string;    // derived from file extension
  lastSeenAt: string;
}

export interface ScoredMemory extends Memory {
  score: number;
  sessionTitle?: string;
  sessionSummary?: string;
}

export interface ContextBundle {
  activeTask: Task | null;
  nextTasks: Task[];
  keyMemories: ScoredMemory[];
  sessionSummary: string;
}
