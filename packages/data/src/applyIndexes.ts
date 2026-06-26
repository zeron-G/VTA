/**
 * applyIndexes — create the pgvector ANN + full-text + tenant indexes that the
 * retrieval queries depend on but that drizzle-kit does NOT manage.
 *
 * drizzle-kit's `db:push` / `db:generate` create the `chunks` table, but it does
 * NOT emit:
 *   - the `vector` extension,
 *   - the HNSW (cosine) ANN index used by the dense/vector retrieval arm
 *     (`@vta/data` `ChunkRepository.searchByEmbedding`, distance op
 *     `vector_cosine_ops`),
 *   - the GIN full-text index on `to_tsvector('english', content)` used by the
 *     keyword arm in `@vta/rag` `RagRetriever.keywordSearch`,
 *   - the btree index on the denormalized tenant key `course_id`.
 *
 * This script applies all of them with idempotent `IF NOT EXISTS` statements, so
 * it is safe to run repeatedly. Run it ONCE after `pnpm db:push` (and again after
 * any reset that drops the table). See `infra/README.md`.
 *
 * Usage (from the repo root):
 *   pnpm db:indexes
 * or directly:
 *   tsx src/applyIndexes.ts
 *
 * Requires `DATABASE_URL` in the environment.
 */

import pg from "pg";

const { Client } = pg;

/**
 * The index statements to apply, in order. Each is idempotent (`IF NOT EXISTS`).
 *
 * The expressions here MUST match the retrieval queries exactly:
 *   - `vector_cosine_ops` matches the cosine distance op used by the vector arm.
 *   - `to_tsvector('english', content)` matches `RagRetriever.keywordSearch`.
 */
const STATEMENTS: ReadonlyArray<{ readonly label: string; readonly sql: string }> = [
  {
    label: "CREATE EXTENSION IF NOT EXISTS vector",
    sql: "CREATE EXTENSION IF NOT EXISTS vector;",
  },
  {
    label: "CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw (HNSW, vector_cosine_ops)",
    sql: "CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);",
  },
  {
    label: "CREATE INDEX IF NOT EXISTS chunks_content_fts (GIN, to_tsvector('english', content))",
    sql: "CREATE INDEX IF NOT EXISTS chunks_content_fts ON chunks USING gin (to_tsvector('english', content));",
  },
  {
    label: "CREATE INDEX IF NOT EXISTS chunks_course_id (btree, course_id)",
    sql: "CREATE INDEX IF NOT EXISTS chunks_course_id ON chunks (course_id);",
  },
];

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set; cannot apply indexes. Set it (see infra/README.md) and retry.",
    );
  }

  const client = new Client({ connectionString });
  await client.connect();
  console.log("[db:indexes] connected; applying %d statement(s)", STATEMENTS.length);
  try {
    for (const { label, sql } of STATEMENTS) {
      console.log("[db:indexes] running: %s", label);
      await client.query(sql);
      console.log("[db:indexes] ok: %s", label);
    }
    console.log("[db:indexes] all statements applied successfully");
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error("[db:indexes] failed:", err);
  process.exitCode = 1;
});
