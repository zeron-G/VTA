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
import { ModelRouter, OpenRouterWebSearch } from '@vta/llm';
import type { EmbeddingProvider } from '@vta/rag';
import { RagRetriever } from '@vta/rag';
import { createDefaultTools } from '@vta/tools';
import {
  EgressGovernor,
  HeuristicInjectionDetector,
  CompositeInjectionDetector,
  IngressGovernor,
  RegexPiiRedactor,
  ToolGate,
} from '@vta/governance';
import type { Moderator } from '@vta/governance';
import { StaticFallbackAgent, FallbackAgent, PiAgent } from '@vta/agent';
import type { CourseAgent } from '@vta/agent';
import { AuditService } from '@vta/audit';
import { loadCourseConfig } from '@vta/tenancy';
import type { ResolvedCourseConfig } from '@vta/tenancy';

import { routerJudge } from './llmJudge.js';
import { routerInjectionDetector, routerModerator } from './guardrails.js';
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

  // --- Web search via OpenRouter's `:online` mechanism, using the SAME
  //     `openrouter.api-key` as the rest of the model traffic (no OpenAI needed).
  //     The searcher is built lazily on first use so construction stays I/O-free;
  //     `@vta/tools` adds a `web_search` tool when this is given.
  let webSearcher: OpenRouterWebSearch | undefined;
  const webSearch = async (query: string): ReturnType<OpenRouterWebSearch['search']> => {
    if (webSearcher === undefined) {
      const apiKey = await config.secrets.require('openrouter.api-key');
      webSearcher = new OpenRouterWebSearch({ apiKey });
    }
    return webSearcher.search(query);
  };

  // --- Tools + the structural, default-deny tool gate. -----------------------
  const tools = createDefaultTools({ retriever, db, webSearch });
  // Default allowlist (retrieve + catalog_lookup + web_search) — read-only set.
  const toolgate = new ToolGate();

  // --- Governance: ingress + egress, wired with the working default ports. ---
  // Injection detection combines the fast heuristic with an LLM classifier
  // (guard.judge): the model catches subtle attempts the regex misses, and a
  // model outage degrades to the heuristic rather than blocking everything.
  // (PII is regex today; swap for Presidio by editing only this.)
  const ingress = new IngressGovernor({
    injection: new CompositeInjectionDetector([
      new HeuristicInjectionDetector(),
      routerInjectionDetector(router),
    ]),
    pii: new RegexPiiRedactor(),
  });

  // Egress: the content-boundary judge and the content-safety moderator both run
  // on the `guard.judge` role via the router (so they follow the active profile —
  // OpenRouter today — with no provider-specific endpoint). Moderation is a
  // fail-open backstop; output PII uses the regex redactor.
  const moderator: Moderator = routerModerator(router);
  const egress = new EgressGovernor({
    pii: new RegexPiiRedactor(),
    judge: routerJudge(router),
    moderator,
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
