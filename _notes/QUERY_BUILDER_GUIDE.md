# Kuzu SDK Query Builder Guide

This guide shows how to use the improved Kuzu SDK integration with prepared statements, streaming support, and better resource management.

## Migration from String Interpolation to Parameters

### Before (String Escaping)
```typescript
import { escape, queryAll } from "./kuzu-helpers.js";

const projectId = "my-project";
const rows = await queryAll(conn,
  `MATCH (m:Memory {projectId: '${escape(projectId)}'}) RETURN m`
);
```

**Problems:**
- Manual escaping required for every parameter
- Error-prone (easy to forget `escape()`)
- String concatenation is slow
- Difficult to spot SQL-injection risks

### After (Prepared Statements)
```typescript
import { queryBuilder } from "./kuzu-helpers.js";

const projectId = "my-project";
const rows = await queryBuilder(conn)
  .cypher(`MATCH (m:Memory {projectId: $projectId}) RETURN m`)
  .param("projectId", projectId)
  .all();
```

**Benefits:**
- Automatic parameter binding (no escaping needed)
- Prepared statements are cached for performance
- Type-safe
- Query intent is clearer

---

## Common Patterns

### Single Row Lookup
```typescript
const memory = await queryBuilder(conn)
  .cypher(`MATCH (m:Memory {id: $id}) RETURN m`)
  .param("id", memoryId)
  .one(); // Returns first row or undefined
```

### Create with Multiple Parameters
```typescript
await queryBuilder(conn)
  .cypher(`CREATE (m:Memory {
    id: $id,
    title: $title,
    summary: $summary,
    projectId: $projectId,
    embedding: $embedding
  })`)
  .param("id", uuid)
  .param("title", "My Memory")
  .param("summary", "Details...")
  .param("projectId", projectId)
  .param("embedding", vectorArray)
  .count(); // Returns number of nodes created
```

### Update with Conditions
```typescript
await queryBuilder(conn)
  .cypher(`MATCH (m:Memory {id: $id, kind: 'decision'})
           SET m.status = $status, m.updatedAt = $now`)
  .param("id", memoryId)
  .param("status", "implemented")
  .param("now", new Date().toISOString())
  .count();
```

### Multiple Queries in Parallel
```typescript
const [memories, turns, sessions] = await Promise.all([
  queryBuilder(conn)
    .cypher(`MATCH (m:Memory {projectId: $pid}) RETURN m`)
    .param("pid", projectId)
    .all(),
  queryBuilder(conn)
    .cypher(`MATCH (t:Turn {projectId: $pid}) RETURN t`)
    .param("pid", projectId)
    .all(),
  queryBuilder(conn)
    .cypher(`MATCH (s:Session {projectId: $pid}) RETURN s`)
    .param("pid", projectId)
    .all(),
]);
```

---

## Advanced Features

### Streaming Large Result Sets
For queries that return many rows, stream them to avoid loading everything into memory:

```typescript
// Iterate through millions of rows without loading all at once
for await (const memory of queryBuilder(conn)
  .cypher(`MATCH (m:Memory {projectId: $pid}) RETURN m`)
  .param("pid", projectId)
  .stream()) {
  processMemory(memory["m"]);
}
```

### Query Timeout
Prevent runaway queries from blocking forever:

```typescript
await queryBuilder(conn)
  .cypher(`MATCH (m:Memory)-[:RELATED_TO*0..5]->(n:Memory) RETURN m, n`)
  .param("pid", projectId)
  .timeout(30_000) // 30 seconds
  .all();
```

### Progress Tracking
Show progress for long-running queries:

```typescript
await queryBuilder(conn)
  .cypher(`MATCH (m:Memory)-[:RELATED_TO]->(n:Memory) RETURN m, n`)
  .param("pid", projectId)
  .progress((pipelineProgress, finished, total) => {
    console.log(`${finished}/${total} pipelines, ${pipelineProgress}% done`);
  })
  .all();
```

### Thread Control
Parallelize heavy computations:

```typescript
await queryBuilder(conn)
  .cypher(`MATCH (m:Memory {projectId: $pid})
           RETURN m, sum(size(m.embedding)) as totalEmbeddings`)
  .param("pid", projectId)
  .maxThreads(8) // Use 8 CPU threads
  .count();
```

### Column Metadata
Get type information about result columns:

```typescript
const { names, types } = await queryBuilder(conn)
  .cypher(`MATCH (m:Memory) RETURN m.id, m.embedding`)
  .columns();

console.log(names); // ["m.id", "m.embedding"]
console.log(types); // ["STRING", "FLOAT[]"]
```

---

## Builder Methods Reference

| Method | Returns | Use Case |
|--------|---------|----------|
| `.cypher(str)` | `this` | Set the Cypher query (with $param placeholders) |
| `.param(name, value)` | `this` | Add a single parameter |
| `.params(obj)` | `this` | Set multiple parameters at once |
| `.timeout(ms)` | `this` | Set query timeout in milliseconds |
| `.maxThreads(n)` | `this` | Set number of threads for execution |
| `.progress(cb)` | `this` | Add progress callback |
| `.all()` | `Promise<Record[]>` | Execute and get all rows |
| `.allSync()` | `Record[]` | Execute synchronously and get all rows |
| `.one()` | `Promise<Record \| undefined>` | Execute and get first row |
| `.oneSync()` | `Record \| undefined` | Execute synchronously and get first row |
| `.stream()` | `AsyncGenerator<Record>` | Stream rows one at a time |
| `.count()` | `Promise<number>` | Execute and return row count |
| `.columns()` | `Promise<{names, types}>` | Get column metadata |
| `.columnNames()` | `Promise<string[]>` | Get just column names |

---

## Prepared Statement Caching

Prepared statements are automatically cached by Cypher string, so repeated queries are reused:

```typescript
// First call: parses and caches the prepared statement
await queryBuilder(conn)
  .cypher(`MATCH (m:Memory {projectId: $pid}) RETURN m`)
  .param("pid", "proj1")
  .all();

// Second call: reuses cached prepared statement
await queryBuilder(conn)
  .cypher(`MATCH (m:Memory {projectId: $pid}) RETURN m`)
  .param("pid", "proj2")
  .all();
```

The cache key is the Cypher string, not the parameters, so:
- Same Cypher pattern = reused prepared statement
- Different parameters = different execution
- No cache bloat (bounded by unique Cypher patterns in your code)

---

## Backwards Compatibility

The old `escape()` and `queryAll()` helpers are still available for legacy code:

```typescript
import { escape, queryAll } from "./kuzu-helpers.js";

const rows = await queryAll(conn, `MATCH (m:Memory {id: '${escape(id)}'}) RETURN m`);
```

But prefer the new builder pattern for all new code:

```typescript
import { queryBuilder } from "./kuzu-helpers.js";

const rows = await queryBuilder(conn)
  .cypher(`MATCH (m:Memory {id: $id}) RETURN m`)
  .param("id", id)
  .all();
```

---

## File-by-File Refactoring Status

✅ **Refactored:**
- `kuzu-helpers.ts` — Query builder implementation
- `search.ts` — Semantic search with graph walks
- `update-decision-status.ts` — Decision status tracking
- `promote-memory.ts` — Memory promotion and linking
- `append-turn.ts` — Turn node creation and file linking

⏳ **Still using legacy pattern (can refactor):**
- `db.ts` — Schema migrations and backfills
- Other CLI-related files

The legacy helpers remain for backwards compatibility, but new code should use `queryBuilder()`.
