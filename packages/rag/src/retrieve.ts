/**
 * Hybrid retrieval: combine dense (vector) and sparse (keyword) recall, fuse the
 * two ranked lists with Reciprocal Rank Fusion (RRF), and return the top-k
 * chunks plus deduped citations.
 *
 * Why hybrid: vector search captures paraphrase/semantic matches but misses
 * exact terms (course codes, function names, acronyms); Postgres full-text
 * search nails those exact-term hits. RRF blends them without needing the two
 * scores to be on the same scale — it ranks purely by position in each list.
 *
 * Tenant safety: BOTH retrieval arms are scoped to a single `courseId`. The
 * vector arm scopes inside `ChunkRepository.searchByEmbedding`; the keyword arm
 * filters `WHERE course_id = $courseId` in a PARAMETERIZED query (the user query
 * is never string-interpolated, so it cannot be used for SQL injection).
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Citation, CourseId, Logger } from '@vta/shared';
import { createLogger } from '@vta/shared';
import { materials } from '@vta/data';
import type { ChunkRepository, ChunkSearchHit, Db } from '@vta/data';

import type { EmbeddingProvider, RetrievalResult, RetrievedChunk } from './types.js';

/** Dependencies injected into the retriever. */
export interface RagRetrieverDeps {
  readonly embedder: EmbeddingProvider;
  readonly chunkRepo: ChunkRepository;
  readonly db: Db;
  readonly logger?: Logger;
}

export interface RetrieveOptions {
  /** Number of fused chunks to return. Default 8. */
  readonly k?: number;
  /**
   * Cosine-distance ceiling for the VECTOR arm: candidates with distance above
   * this are dropped as too weak to be relevant. Keyword (exact-lexical) hits
   * are never distance-filtered. Default {@link DEFAULT_MAX_DISTANCE}.
   */
  readonly maxDistance?: number;
}

/**
 * The RRF dampening constant. The canonical value from the original RRF paper
 * (Cormack et al.) is 60; it controls how quickly a rank's contribution decays.
 * Score for an item = Σ over lists of 1 / (RRF_K + rank), rank being 1-based.
 */
const RRF_K = 60;

/** Default number of fused results to return. */
const DEFAULT_K = 8;

/**
 * Default cosine-distance ceiling for the vector arm. pgvector cosine distance
 * runs 0 (identical) .. 2 (opposite); for text-embedding-3-small, genuinely
 * relevant course chunks typically sit well below ~0.6 while off-topic chunks
 * sit above it. Filtering here prevents weak semantic matches from becoming
 * SPURIOUS citations when the course has nothing actually relevant — in which
 * case retrieval returns empty and the agent falls through to web search.
 */
const DEFAULT_MAX_DISTANCE = 0.6;

/** A row from the keyword (full-text) search arm. */
interface KeywordHit {
  readonly id: string;
  readonly materialId: string;
  readonly content: string;
}

/**
 * Course-scoped hybrid retriever. Stateless across calls except for its
 * injected dependencies; `courseId` is supplied per call.
 */
export class RagRetriever {
  private readonly embedder: EmbeddingProvider;
  private readonly chunkRepo: ChunkRepository;
  private readonly db: Db;
  private readonly log: Logger;

  constructor(deps: RagRetrieverDeps) {
    this.embedder = deps.embedder;
    this.chunkRepo = deps.chunkRepo;
    this.db = deps.db;
    this.log = deps.logger ?? createLogger({ name: 'rag-retriever' });
  }

  /**
   * Retrieve the most relevant chunks for `query` within ONE course.
   *
   * Pipeline:
   *   1. Embed the query.
   *   2. Vector search (k*2 candidates) — semantic recall.
   *   3. Keyword search (k*2 candidates) — exact-term recall, parameterized.
   *   4. Fuse both lists with RRF.
   *   5. Return the top-k fused chunks + deduped citations (one per material).
   */
  async retrieve(
    courseId: CourseId,
    query: string,
    opts: RetrieveOptions = {},
  ): Promise<RetrievalResult> {
    const k = normalizeK(opts.k);
    const maxDistance =
      typeof opts.maxDistance === 'number' && Number.isFinite(opts.maxDistance)
        ? opts.maxDistance
        : DEFAULT_MAX_DISTANCE;
    const trimmed = typeof query === 'string' ? query.trim() : '';
    if (trimmed === '') {
      return { chunks: [], citations: [] };
    }

    // Over-fetch from each arm so the fusion has enough candidates to work with.
    const candidateCount = k * 2;

    // (1) Embed the query. The provider returns one vector per input text.
    const embeddings = await this.embedder.embed([trimmed]);
    const queryEmbedding = embeddings[0];
    if (queryEmbedding === undefined) {
      throw new Error('retrieve: embedder returned no vector for the query');
    }

    // (2) + (3) Run both arms. They are independent, so issue concurrently.
    const [vectorHits, keywordHits] = await Promise.all([
      this.chunkRepo.searchByEmbedding(courseId, queryEmbedding, candidateCount),
      this.keywordSearch(courseId, trimmed, candidateCount),
    ]);

    // (3b) Relevance floor on the vector arm: drop candidates too far to be
    // relevant, so a course with nothing on-topic yields NO spurious citations
    // (and the agent then goes to web search). Keyword hits are exact-lexical
    // matches and are kept as-is.
    const relevantVectorHits = vectorHits.filter((h) => h.distance <= maxDistance);

    // (4) Fuse.
    const fused = reciprocalRankFusion(relevantVectorHits, keywordHits);

    // (5) Top-k, then resolve human-readable material titles so citations show
    // real titles instead of opaque material UUIDs.
    const top = fused.slice(0, k);
    const titles = await this.fetchTitles(
      courseId,
      [...new Set(top.map((c) => c.materialId))],
    );
    const topChunks: RetrievedChunk[] = top.map((c) => ({
      ...c,
      title: titles.get(c.materialId) ?? c.materialId,
    }));
    const citations = buildCitations(topChunks);

    this.log.debug(
      {
        courseId,
        k,
        vectorHits: vectorHits.length,
        relevantVectorHits: relevantVectorHits.length,
        keywordHits: keywordHits.length,
        maxDistance,
        returned: topChunks.length,
      },
      'hybrid retrieval complete',
    );

    return { chunks: topChunks, citations };
  }

  /**
   * Keyword arm: Postgres full-text search over `chunks.content`, scoped to the
   * course.
   *
   * Security: the user query is bound as a PARAMETER (`${trimmed}`) and handed to
   * `websearch_to_tsquery`, NOT concatenated into SQL. `websearch_to_tsquery`
   * also tolerates arbitrary user punctuation without throwing (unlike
   * `to_tsquery`), so we do not need to pre-sanitize the input.
   *
   * Ranking uses `ts_rank` so the best lexical matches come first; we only need
   * the relative order for RRF, not the absolute score.
   *
   * The matching GIN index on `to_tsvector('english', content)` (and the HNSW
   * index on `embedding` for the vector arm) are created by `pnpm db:indexes`
   * (packages/data/src/applyIndexes.ts), which must be run once after `db:push`.
   */
  private async keywordSearch(
    courseId: CourseId,
    query: string,
    limit: number,
  ): Promise<KeywordHit[]> {
    const result = await this.db.execute<{
      id: string;
      material_id: string;
      content: string;
    }>(sql`
      SELECT id, material_id, content
      FROM chunks
      WHERE course_id = ${courseId}
        AND to_tsvector('english', content) @@ websearch_to_tsquery('english', ${query})
      ORDER BY ts_rank(
        to_tsvector('english', content),
        websearch_to_tsquery('english', ${query})
      ) DESC
      LIMIT ${limit}
    `);

    // node-postgres returns a QueryResult with rows on `.rows`; guard defensively.
    const rows = (result as { rows?: unknown }).rows;
    if (!Array.isArray(rows)) return [];
    return (rows as Array<{ id: string; material_id: string; content: string }>).map((r) => ({
      id: r.id,
      materialId: r.material_id,
      content: r.content,
    }));
  }

  /**
   * Resolve material titles for a set of material ids, scoped to the course.
   * Gives citations human-readable titles instead of raw UUIDs. Returns a map of
   * materialId -> title; ids without a (course-scoped) row are omitted.
   */
  private async fetchTitles(
    courseId: CourseId,
    materialIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (materialIds.length === 0) return new Map();
    const rows = await this.db
      .select({ id: materials.id, title: materials.title })
      .from(materials)
      .where(
        and(eq(materials.courseId, courseId), inArray(materials.id, [...materialIds])),
      );
    return new Map(rows.map((r) => [r.id, r.title]));
  }
}

// -----------------------------------------------------------------------------
// Pure fusion + citation helpers (module-private, deterministic).
// -----------------------------------------------------------------------------

/**
 * Reciprocal Rank Fusion of the vector and keyword result lists.
 *
 * For each list, the item at 1-based rank `r` contributes `1 / (RRF_K + r)` to
 * its chunk's fused score. A chunk appearing in both lists accumulates both
 * contributions, so consensus across arms is rewarded. Output is sorted by
 * descending fused score; ties break deterministically by chunkId so results
 * are stable across runs.
 */
function reciprocalRankFusion(
  vectorHits: readonly ChunkSearchHit[],
  keywordHits: readonly KeywordHit[],
): RetrievedChunk[] {
  // Accumulate scores and remember the chunk payload (content/materialId) the
  // first time we see each chunk id.
  const scores = new Map<string, number>();
  const payloads = new Map<
    string,
    { materialId: string; content: string; ord?: number }
  >();

  const accumulate = (
    id: string,
    rankZeroBased: number,
    materialId: string,
    content: string,
    ord?: number,
  ): void => {
    const contribution = 1 / (RRF_K + rankZeroBased + 1); // +1 => 1-based rank
    scores.set(id, (scores.get(id) ?? 0) + contribution);
    if (!payloads.has(id)) payloads.set(id, { materialId, content, ord });
  };

  // Vector hits carry `ord` (chunk position within its material); we use it as a
  // human-friendly citation locator. Keyword hits have no ord.
  vectorHits.forEach((hit, i) =>
    accumulate(hit.id, i, hit.materialId, hit.content, hit.ord),
  );
  keywordHits.forEach((hit, i) => accumulate(hit.id, i, hit.materialId, hit.content));

  const fused: RetrievedChunk[] = [];
  for (const [id, score] of scores) {
    const payload = payloads.get(id);
    if (payload === undefined) continue; // unreachable; satisfies the type guard
    fused.push({
      chunkId: id,
      materialId: payload.materialId,
      content: payload.content,
      score,
      ...(payload.ord !== undefined ? { locator: `chunk ${payload.ord}` } : {}),
    });
  }

  fused.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Deterministic tie-break so identical-score results never reorder run-to-run.
    return a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0;
  });

  return fused;
}

/**
 * Build a deduped citation list from the retrieved chunks, one entry per source
 * material. The orchestrator refuses to answer without citations, so this must
 * be a faithful, deduplicated provenance of the grounding chunks.
 *
 * `Citation.sourceId` is the material id; `title`/`locator` are best-effort.
 * When a chunk carries no title we fall back to the material id so the citation
 * is still well-formed.
 */
function buildCitations(chunks: readonly RetrievedChunk[]): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const chunk of chunks) {
    if (seen.has(chunk.materialId)) continue;
    seen.add(chunk.materialId);
    const citation: Citation = {
      sourceId: chunk.materialId,
      title: chunk.title ?? chunk.materialId,
      ...(chunk.locator !== undefined ? { locator: chunk.locator } : {}),
    };
    citations.push(citation);
  }
  return citations;
}

/** Clamp/normalize the requested k to a sane positive integer. */
function normalizeK(k: number | undefined): number {
  if (k === undefined || !Number.isFinite(k) || k <= 0) return DEFAULT_K;
  return Math.trunc(k);
}
