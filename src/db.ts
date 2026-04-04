import kuzu from "kuzu";
import * as path from "path";

let _db: InstanceType<typeof kuzu.Database> | null = null;
let _conn: InstanceType<typeof kuzu.Connection> | null = null;

export function getDb(projectMemoryDir: string): {
  db: InstanceType<typeof kuzu.Database>;
  conn: InstanceType<typeof kuzu.Connection>;
} {
  if (_db && _conn) return { db: _db, conn: _conn };

  const kuzuDir = path.join(projectMemoryDir, "kuzu");
  // Kuzu creates the directory itself — do not pre-create it
  _db = new kuzu.Database(kuzuDir);
  _conn = new kuzu.Connection(_db);
  return { db: _db, conn: _conn };
}

export async function applySchema(
  conn: InstanceType<typeof kuzu.Connection>
): Promise<void> {
  const statements = [
    `CREATE NODE TABLE IF NOT EXISTS Project(
      id STRING,
      name STRING,
      remoteUrl STRING,
      repoPath STRING,
      createdAt STRING,
      PRIMARY KEY (id)
    )`,
    `CREATE NODE TABLE IF NOT EXISTS Session(
      id STRING,
      projectId STRING,
      startedAt STRING,
      summary STRING,
      PRIMARY KEY (id)
    )`,
    `CREATE NODE TABLE IF NOT EXISTS Memory(
      id STRING,
      kind STRING,
      title STRING,
      summary STRING,
      recallCue STRING,
      projectId STRING,
      sessionId STRING,
      createdAt STRING,
      status STRING,
      artifactId STRING,
      PRIMARY KEY (id)
    )`,
    `CREATE NODE TABLE IF NOT EXISTS Artifact(
      id STRING,
      type STRING,
      title STRING,
      summary STRING,
      location STRING,
      projectId STRING,
      sessionId STRING,
      createdAt STRING,
      PRIMARY KEY (id)
    )`,
    `CREATE REL TABLE IF NOT EXISTS HAS_SESSION(FROM Project TO Session)`,
    `CREATE REL TABLE IF NOT EXISTS HAS_MEMORY(FROM Session TO Memory)`,
    `CREATE REL TABLE IF NOT EXISTS PRODUCED(FROM Session TO Artifact)`,
    `CREATE REL TABLE IF NOT EXISTS REFERS_TO(FROM Memory TO Artifact)`,
    `CREATE REL TABLE IF NOT EXISTS SUPERSEDES(FROM Memory TO Memory)`,
    `CREATE REL TABLE IF NOT EXISTS RELATED_TO(FROM Memory TO Memory)`,
  ];

  for (const stmt of statements) {
    await conn.query(stmt);
  }
}
