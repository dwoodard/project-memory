/**
 * Preset exploration paths for common questions
 * Each path is a pre-defined search + walk combination
 */

export interface WalkPath {
  id: string;
  name: string;
  description: string;
  query: string;
  category: "architecture" | "decisions" | "implementation" | "blockers" | "task-planning" | "onboarding";
}

export const WALK_PATHS: WalkPath[] = [
  {
    id: "pending-decisions",
    name: "Pending Architectural Decisions",
    description: "Show all decisions that haven't been implemented yet",
    query: "decision pending architecture",
    category: "decisions",
  },
  {
    id: "blocked-work",
    name: "Blocked Work & Blockers",
    description: "Find all blockers and blocked tasks preventing progress",
    query: "blocker blocked obstacle issue",
    category: "blockers",
  },
  {
    id: "task-system",
    name: "Task & Workflow System Design",
    description: "Explore all decisions about the task system, hierarchy, and workflow",
    query: "task queue branch hierarchy workflow",
    category: "task-planning",
  },
  {
    id: "schema-decisions",
    name: "Database & Schema Architecture",
    description: "Show decisions about the graph schema, data structure, and relationships",
    query: "schema graph database relationship node",
    category: "architecture",
  },
  {
    id: "deployment",
    name: "Deployment & Visibility",
    description: "Find deployment strategy, visibility concerns, and verification approaches",
    query: "deployment visibility verification release",
    category: "implementation",
  },
  {
    id: "memory-system",
    name: "Memory & Context System",
    description: "Explore the AI memory architecture, ranking, and retrieval",
    query: "memory ranking retrieval context architecture",
    category: "architecture",
  },
  {
    id: "branch-strategy",
    name: "Branching & Git Workflow",
    description: "Show decisions about branch naming, visibility, and workflow",
    query: "branch git workflow master develop feature",
    category: "task-planning",
  },
  {
    id: "recent-progress",
    name: "Recent Implementation Progress",
    description: "Find what was recently implemented and completed",
    query: "implemented completed done feature built",
    category: "implementation",
  },
  {
    id: "ai-visibility",
    name: "AI Scope & Visibility",
    description: "Explore decisions about what context the AI should see",
    query: "AI visibility scope context access",
    category: "onboarding",
  },
  {
    id: "technical-debt",
    name: "Technical Debt & Tradeoffs",
    description: "Find identified technical debt and acknowledged tradeoffs",
    query: "technical debt coupling tradeoff risk",
    category: "architecture",
  },
];

/**
 * Get all available walk paths
 */
export function listWalkPaths(): WalkPath[] {
  return WALK_PATHS;
}

/**
 * Get paths by category
 */
export function getPathsByCategory(category: WalkPath["category"]): WalkPath[] {
  return WALK_PATHS.filter((p) => p.category === category);
}

/**
 * Find a path by ID
 */
export function getPathById(id: string): WalkPath | undefined {
  return WALK_PATHS.find((p) => p.id === id);
}

/**
 * Get the command to run a specific walk path
 */
export function getWalkCommand(pathId: string): string {
  const path = getPathById(pathId);
  if (!path) throw new Error(`Unknown walk path: ${pathId}`);
  return `pensieve search "${path.query}" --walk`;
}

/**
 * Format paths for display
 */
export function formatPathList(): string {
  const byCategory: Record<string, WalkPath[]> = {};

  for (const path of WALK_PATHS) {
    if (!byCategory[path.category]) byCategory[path.category] = [];
    byCategory[path.category].push(path);
  }

  const lines: string[] = ["Available Walk Paths:", ""];

  for (const category of Object.keys(byCategory).sort()) {
    lines.push(`## ${category.replace(/-/g, " ").toUpperCase()}`);
    for (const path of byCategory[category]) {
      lines.push(`- ${path.id}`);
      lines.push(`  ${path.name}`);
      lines.push(`  → ${path.description}`);
      lines.push(`  Search: "${path.query}"`);
      lines.push("");
    }
  }

  return lines.join("\n");
}
