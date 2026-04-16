import {
  parseNodeSelector,
  traverseGraph,
  type GraphNode,
  type NeighborFetcher,
} from "./walk.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    failed++;
  }
}

function node(id: string, type = "Memory"): GraphNode {
  return { id, type, label: id, properties: { id } };
}

function makeFetcher(edges: Record<string, string[]>): NeighborFetcher {
  return async (source, relation, direction) => {
    const key = `${source.id}:${relation}:${direction}`;
    return (edges[key] ?? []).map((id: string) => ({ node: node(id), properties: {} }));
  };
}

async function testSelectorParsing() {
  console.log("\n── parseNodeSelector ───────────────────────────");
  const sel = parseNodeSelector("memory:abc-123");
  assert(sel.id === "abc-123", "selector parses id suffix");
  assert(sel.type === "Memory", "selector maps shorthand type to canonical label");

  const raw = parseNodeSelector("abc-123");
  assert(raw.id === "abc-123" && raw.type === undefined, "plain id remains untyped");
}

async function testBfsVsDfsOrder() {
  console.log("\n── traverseGraph strategy ──────────────────────");
  const start = node("A");
  const fetcher = makeFetcher({
    "A:REL:outbound": ["B", "C"],
    "B:REL:outbound": ["D"],
    "C:REL:outbound": ["E"],
    "D:REL:outbound": [],
    "E:REL:outbound": [],
  });

  const bfs = await traverseGraph(start, { relations: ["REL"], depth: 2, strategy: "bfs" }, fetcher);
  const dfs = await traverseGraph(start, { relations: ["REL"], depth: 2, strategy: "dfs" }, fetcher);

  assert(bfs.nodes.map((n) => n.node.id).join(",") === "A,B,C,D,E", "BFS visits breadth-first order");
  assert(dfs.nodes[1]?.node.id === "C", "DFS diverges from BFS based on stack traversal");
}

async function testDirectionAndLimits() {
  console.log("\n── traverseGraph direction/limits ─────────────");
  const start = node("B");
  const fetcher = makeFetcher({
    "B:REL:inbound": ["A"],
    "B:REL:outbound": ["C"],
    "A:REL:inbound": [],
    "A:REL:outbound": [],
    "C:REL:inbound": [],
    "C:REL:outbound": [],
  });

  const both = await traverseGraph(start, { relations: ["REL"], direction: "both", depth: 1 }, fetcher);
  const ids = new Set(both.nodes.map((n) => n.node.id));
  assert(ids.has("A") && ids.has("B") && ids.has("C"), "both direction traverses inbound and outbound neighbors");

  const limited = await traverseGraph(start, { relations: ["REL"], direction: "both", depth: 2, maxNodes: 2 }, fetcher);
  assert(limited.metadata.truncated, "maxNodes truncates traversal");
  assert(limited.metadata.truncationReason === "maxNodes", "truncation reason identifies maxNodes");
}

(async () => {
  console.log("pensieve walk tests\n");
  await testSelectorParsing();
  await testBfsVsDfsOrder();
  await testDirectionAndLimits();

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
