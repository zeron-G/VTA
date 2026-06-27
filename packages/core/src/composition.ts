/**
 * `createTeachingService` — the COMPOSITION ROOT.
 *
 * This is the ONE place in the system where concrete implementations are chosen
 * and wired. Every other package depends only on interfaces / injected deps; the
 * decisions "use the heuristic injection detector", "use the regex PII redactor",
 * "route the judge through guard.judge", "Pi primary with a Codex fallback" all
 * live here and nowhere else. Swapping any of them (Presidio, Prompt Guard 2,
 * Llama Guard, a different agent) is a change to this file alone.
 *
 * What it builds, in dependency order:
 *   ModelRouter → embedder adapter → data repositories → RagRetriever →
 *   default tools → ToolGate → Ingress/Egress governors → Pi/Codex/Fallback
 *   agents → AuditService → config-loader closure → TeachingService.
 *
 * The request path (answering) is assembled here. The admin INGESTION path lives
 * in `./ingestionService.ts` and is composed separately — onboarding/sync must
 * not share a code path with answering.
 */

import type { Db } from '@vta/data';
import {
  AuditRepository,
  ChunkRepository,
  createDb,
} from '@vta/data';
import type { SecretsProvider, Logger } from '@vta/shared';
import { createLogger } from '@vta/shared';
import type { RoleMapping } from '@vta/llm';
import { ModelRouter } from '@vta/llm';
import type { EmbeddingProvider } from '@vta/rag';
import { RagRetriever } from '@vta/rag';
import { createDefaultTools } from '@vta/tools';
import {
  EgressGovernor,
  HeuristicInjectionDetector,
  IngressGovernor,
  RegexPiiRedactor,
  ToolGate,
} from '@vta/governance';
import { StaticFallbackAgent, FallbackAgent, PiAgent } from '@vta/agent';
import type { CourseAgent } from '@vta/agent';
import { AuditService } from '@vta/audit';
import { loadCourseConfig } from '@vta/tenancy';
import type { ResolvedCourseConfig } from '@vta/tenancy';

import { routerJudge } from './llmJudge.js';
import { TeachingService } from './teachingService.js';

/**
 * Inputs to the composition root.
 *
 * Provide EITHER a ready `Db` (preferred when the app already owns a pool) OR a
 * `databaseUrl` from which one is created here. The `secrets` provider and the
 * active LLM `mapping` (from `loadProfile(name)`) are always required.
 */
export interface CoreConfig {
  /** A ready database handle. Mutually exclusive with {@link databaseUrl}. */
  readonly db?: Db;
  /** A Postgres `DATABASE_URL`; a `Db` is built from it when {@link db} is absent. */
  readonly databaseUrl?: string;
  /** Secrets provider (LLM keys, Canvas tokens). */
  readonly secrets: SecretsProvider;
  /** The active LLM role→model mapping, from `@vta/llm`'s `loadProfile(name)`. */
  readonly mapping: RoleMapping;
  /** Optional root logger; named children are derived per component. */
  readonly logger?: Logger;
}

/** Resolve the `Db`: use the supplied handle, else build one from the URL. */
function resolveDb(config: CoreConfig): Db {
  if (config.db !== undefined) return config.db;
  if (config.databaseUrl !== undefined && config.databaseUrl !== '') {
    return createDb(config.databaseUrl);
  }
  throw new Error('createTeachingService: provide either `db` or `databaseUrl` in CoreConfig');
}

/**
 * Wire and return a fully-composed {@link TeachingService} ready to `handle`
 * inbound requests. Pure construction — no I/O is performed here (providers are
 * built lazily inside the router; the DB pool is created but not connected to).
 */
export function createTeachingService(config: CoreConfig): TeachingService {
  const log = config.logger ?? createLogger({ name: 'core' });
  const db = resolveDb(config);

  // --- LLM layer: the single entry point to any model, by logical role. ------
  const router = new ModelRouter({ mapping: config.mapping, secrets: config.secrets });

  // The RAG layer needs only an `embed(texts)` capability; adapt the router's
  // `embed` (the `embed` role) to the structural `EmbeddingProvider` port so
  // `@vta/rag` stays decoupled from `@vta/llm`.
  const embedder: EmbeddingProvider = {
    embed: (texts: string[]): Promise<number[][]> => router.embed(texts),
  };

  // --- Data repositories (course-scoped reads for retrieval + audit writes). -
  const chunkRepo = new ChunkRepository(db);
  const auditRepo = new AuditRepository(db);

  // --- Retrieval: hybrid dense+sparse search, scoped per call to one course. -
  const retriever = new RagRetriever({
    embedder,
    chunkRepo,
    db,
    logger: log,
  });

  // --- Tools + the structural, default-deny tool gate. -----------------------
  const tools = createDefaultTools({ retriever, db });
  // Default allowlist (retrieve + catalog_lookup) — the read-only Phase-1 set.
  const toolgate = new ToolGate();

  // --- Governance: ingress + egress, wired with the working default ports. ---
  // Concrete-impl choices live HERE: heuristic injection detector + regex PII
  // redactor today; swap for Prompt Guard 2 / Presidio by editing only this.
  const ingress = new IngressGovernor({
    injection: new HeuristicInjectionDetector(),
    pii: new RegexPiiRedactor(),
  });
  // The egress content-boundary judge runs on the configured `guard.judge`
  // model via the router (see `routerJudge`). Output PII uses the regex redactor.
  const egress = new EgressGovernor({
    pii: new RegexPiiRedactor(),
    judge: routerJudge(router),
  });

  // --- Agent: Pi primary (tool-using, governed loop) with a degraded-but-safe
  //     static fallback. FallbackAgent is permission-monotonic; either output
  //     still flows through the egress gate above. The fallback does no I/O and
  //     runs no subprocess — it returns a fixed "temporarily unavailable" reply.
  const pi = new PiAgent({ router, tools, toolgate, logger: log });
  const degraded = new StaticFallbackAgent({ logger: log });
  const agent: CourseAgent = new FallbackAgent({ primary: pi, fallback: degraded, logger: log });

  // --- Audit: durable, append-only disclosure log writer. --------------------
  const audit = new AuditService(auditRepo, { logger: log });

  // --- Config loader: a closure over tenancy `loadCourseConfig` + the Db, so
  //     the service depends only on `(courseId) => ResolvedCourseConfig`.
  const configLoader = (courseId: string): Promise<ResolvedCourseConfig> =>
    loadCourseConfig({ db }, courseId);

  return new TeachingService({
    loadCourseConfig: configLoader,
    ingress,
    agent,
    egress,
    audit,
    logger: log,
  });
}
