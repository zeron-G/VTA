/**
 * Public types for `@vta/rag` — the package that owns retrieval quality
 * end-to-end (ingestion + hybrid retrieval).
 *
 * The `Citation` type is REUSED from `@vta/shared` rather than redefined here,
 * so a retrieved answer's citations are structurally identical to the ones the
 * orchestrator and governance layer already consume.
 */

import type { Citation } from '@vta/shared';

/**
 * The minimal embedding contract this package needs.
 *
 * We deliberately do NOT depend on `@vta/llm`: the caller injects any object
 * that can turn a batch of texts into a batch of vectors. The LLM router is
 * structurally compatible with this interface, which keeps `@vta/rag` decoupled
 * from the concrete model/provider and trivially testable with a stub.
 *
 * Contract:
 *   - `embed(texts)` returns one vector per input text, in the SAME ORDER.
 *   - Every returned vector must have length `EMBEDDING_DIMENSIONS` (1536), the
 *     dimensionality the `chunks.embedding` column and vector search expect.
 */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * A single chunk returned from retrieval, flattened for the caller. `title` and
 * `locator` are best-effort provenance used to build citations; they may be
 * absent when the originating material metadata is unavailable.
 */
export interface RetrievedChunk {
  readonly chunkId: string;
  readonly materialId: string;
  readonly content: string;
  /** Fused relevance score (higher is better). See RRF in `retrieve.ts`. */
  readonly score: number;
  readonly title?: string;
  /** Finer locator within the material, e.g. "chunk 3". */
  readonly locator?: string;
}

/**
 * The result of a retrieval call: the top-k chunks plus the deduped citations
 * derived from them (one per source material). The orchestrator refuses to
 * answer without citations, so this list is the grounding contract.
 */
export interface RetrievalResult {
  readonly chunks: RetrievedChunk[];
  readonly citations: Citation[];
}

/**
 * Summary statistics returned by an ingestion run. `materialsChanged` counts
 * only materials whose content actually changed (and were therefore re-embedded
 * and re-chunked); unchanged materials are upserted but skip the embed step.
 */
export interface IngestStats {
  readonly materialsProcessed: number;
  readonly materialsChanged: number;
  readonly chunksWritten: number;
  /** Stale materials removed because they no longer exist (or were unpublished) in Canvas. */
  readonly materialsRemoved?: number;
}
