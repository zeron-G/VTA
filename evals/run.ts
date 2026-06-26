/**
 * Governance regression eval runner.
 *
 * Run from the repo root via the "eval" script:  tsx evals/run.ts
 *
 * Pipeline:
 *   1. Discover every evals/cases/<*>.json file.
 *   2. Parse + validate each file against the EvalCase schema (zod).
 *   3. Run each case's input through the TARGET function.
 *   4. Assert the reply against the case's expectations.
 *   5. Print a summary table and exit non-zero on any structural error
 *      (invalid JSON / schema violation) or — once the real target is wired —
 *      any failing case.
 *
 * Phase 0: the TARGET is a STUB that returns a fixed "escalated" result so the
 * harness exercises the whole load -> validate -> run -> assert pipeline
 * end-to-end without depending on any @vta/* package.
 *
 * Phase 1: replace the stub with an adapter over the real TeachingService
 * (see `makeTarget` below) to turn this suite into a CI gate for refusals,
 * injection resistance, grounding/citation, and no-leak guarantees.
 *
 * Dependency-light by design: only `zod` plus the Node stdlib.
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";

import type { z } from "zod";

import {
  EvalCaseFile,
  type EvalCase,
  type EvalInput,
  type EvalResult,
  type EvalStatus,
  type EvalTarget,
  type TargetReply,
} from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(HERE, "cases");

// ---------------------------------------------------------------------------
// TARGET
// ---------------------------------------------------------------------------

/**
 * Build the function under test.
 *
 * The target is PLUGGABLE via the environment:
 *
 *   - DEFAULT (offline) — `tsx evals/run.ts` with no special env builds the
 *     Phase-0 STUB below. It returns a fixed "escalated" reply for every input,
 *     depends on NO @vta/* package, and needs NO database / LLM / network. This
 *     keeps the suite runnable in CI and on a laptop without provisioning
 *     anything. With the stub, cases whose expected status is not "escalated"
 *     report as failing — expected offline, and tolerated unless
 *     FAIL_ON_CASE_FAILURE is on.
 *
 *   - LIVE (real pipeline) — when `EVAL_LIVE=1` AND `DATABASE_URL` is set, a real
 *     target is built over `@vta/core`'s `createTeachingService` (see
 *     {@link makeLiveTarget}). This turns the suite into a true governance
 *     regression gate (refusals, injection resistance, grounding/citation,
 *     no-leak guarantees).
 *
 * The live path is loaded with a DYNAMIC import strictly inside
 * {@link makeLiveTarget} so the default offline path never even resolves
 * `@vta/core` / `@vta/llm` — keeping "no DB required by default" structural, not
 * just conventional.
 */
async function makeTarget(): Promise<EvalTarget> {
  if (LIVE_MODE) {
    return await makeLiveTarget();
  }
  return makeStubTarget();
}

/**
 * PHASE 0 STUB target: a fixed "escalated" reply for every input. Pure, offline,
 * dependency-free. The default when not running in live mode.
 */
function makeStubTarget(): EvalTarget {
  return async (_input: EvalInput): Promise<TargetReply> => {
    return {
      status: "escalated",
      text: "[stub] Phase-0 placeholder target: escalating to a human.",
      citationCount: 0,
    };
  };
}

/**
 * LIVE target: wire the real governed pipeline over `@vta/core`.
 *
 * PRECONDITIONS (operator's responsibility — this path is opt-in via env):
 *   - `DATABASE_URL` points at a Postgres instance that has been MIGRATED and
 *     SEEDED with the course identified by `EVAL_COURSE_ID` (default
 *     "eval-course"), including its `course_config` row and ingested,
 *     embedded materials. Without a seeded course, retrieval returns nothing and
 *     grounded cases will (correctly) refuse.
 *   - An LLM profile is configured and its credentials are resolvable from the
 *     environment via the SecretsProvider: `LLM_PROFILE` (default "dev") selects
 *     the role→model mapping; e.g. the `dev` profile expects a logged-in Codex
 *     CLI for chat roles plus `OPENAI_API_KEY` for embeddings.
 *
 * The dynamic imports are intentional: they only execute in live mode, so the
 * default offline run never depends on these packages being installed/built.
 */
async function makeLiveTarget(): Promise<EvalTarget> {
  const databaseUrl = process.env.DATABASE_URL;
  // Guarded by LIVE_MODE (which already requires DATABASE_URL), but assert so a
  // misconfiguration fails loudly rather than building a broken target.
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error(
      "EVAL_LIVE=1 requires DATABASE_URL to point at a migrated, seeded course database.",
    );
  }

  // Loaded only in live mode — keeps the default path free of @vta/* deps.
  const { createTeachingService } = await import("@vta/core");
  const { loadProfile } = await import("@vta/llm");
  const shared = await import("@vta/shared");
  const { createSecretsProvider, DEFAULT_COURSE_ROLE } = shared;
  // The CourseRole union, kept local so the harness file imports no @vta type.
  type EvalCourseRole = (typeof shared.COURSE_ROLES)[number];

  const profileName = (process.env.LLM_PROFILE ?? "dev") as "dev" | "prod";
  const courseId = process.env.EVAL_COURSE_ID ?? "eval-course";

  const secrets = createSecretsProvider({
    provider: (process.env.SECRETS_PROVIDER as "env" | "keyvault") ?? "env",
    ...(process.env.AZURE_KEY_VAULT_URL !== undefined
      ? { vaultUrl: process.env.AZURE_KEY_VAULT_URL }
      : {}),
  });

  const svc = createTeachingService({
    databaseUrl,
    secrets,
    mapping: loadProfile(profileName),
  });

  let seq = 0;

  return async (input: EvalInput): Promise<TargetReply> => {
    seq += 1;
    // Adapt the harness-local EvalInput into a real, course-scoped
    // InboundRequest. The seeded govContext = (courseId, role) on the request.
    const role: EvalCourseRole = (input.role ?? DEFAULT_COURSE_ROLE) as EvalCourseRole;
    const reply = await svc.handle({
      id: `eval-${seq}`,
      channel: "web",
      courseId,
      userId: "eval-runner",
      role,
      text: input.text,
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      receivedAt: new Date(0).toISOString(),
    });

    return {
      status: toEvalStatus(reply.status),
      text: reply.text,
      citationCount: reply.citations?.length ?? 0,
    };
  };
}

/**
 * Map the rich `ReplyStatus` from `@vta/shared` onto the harness `EvalStatus`.
 * `answered`/`refused`/`escalated` pass through; the operational dispositions
 * `rate_limited` and `error` are treated as `escalated` (a deferral to a human).
 */
function toEvalStatus(status: string): EvalStatus {
  if (status === "answered" || status === "refused" || status === "escalated") {
    return status;
  }
  return "escalated";
}

/** True when the live (real-pipeline) target should be built. */
const LIVE_MODE =
  process.env.EVAL_LIVE === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL !== "";

/**
 * Whether a failing case should fail the process (exit non-zero).
 *
 * Honors the `FAIL_ON_CASE_FAILURE` env flag ("1"/"true"). Defaults to ON in
 * live mode (so the real pipeline gates CI) and OFF offline (the stub cannot
 * satisfy real expectations, so its case failures are tolerated).
 */
const FAIL_ON_CASE_FAILURE = ((): boolean => {
  const raw = process.env.FAIL_ON_CASE_FAILURE?.toLowerCase();
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return LIVE_MODE;
})();

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * Evaluate one case's reply against its expectations.
 */
function assertCase(c: EvalCase, reply: TargetReply): EvalResult {
  const fail = (detail: string): EvalResult => ({ caseId: c.id, passed: false, detail });

  // Status is the primary assertion.
  if (reply.status !== c.expect.status) {
    return fail(`expected status "${c.expect.status}" but got "${reply.status}"`);
  }

  // Citation requirement (only meaningful for answered replies).
  if (c.expect.mustCite === true && reply.citationCount < 1) {
    return fail("expected at least one citation but reply had none");
  }

  // Forbidden substrings (case-insensitive) — leak / disallowed-content checks.
  if (c.expect.mustNotContain && c.expect.mustNotContain.length > 0) {
    const haystack = reply.text.toLowerCase();
    for (const needle of c.expect.mustNotContain) {
      if (haystack.includes(needle.toLowerCase())) {
        return fail(`reply contained forbidden substring: ${JSON.stringify(needle)}`);
      }
    }
  }

  // Refusal reason code (only when the case asserts one).
  if (c.expect.mustRefuseReason !== undefined) {
    if (reply.refuseReason !== c.expect.mustRefuseReason) {
      return fail(
        `expected refuse reason "${c.expect.mustRefuseReason}" but got ` +
          `"${reply.refuseReason ?? "<none>"}"`,
      );
    }
  }

  return { caseId: c.id, passed: true, detail: "ok" };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface LoadedFile {
  /** File name (basename) for diagnostics. */
  file: string;
  /** Validated cases. */
  cases: EvalCase[];
}

/**
 * A structural error: a case file that could not be read, parsed, or validated.
 * These always fail the process (Phase 0 and Phase 1).
 */
class StructuralError extends Error {}

/**
 * Discover and validate all case files. Throws StructuralError on the first
 * malformed file (with a readable message including the zod issue path).
 */
async function loadCases(): Promise<LoadedFile[]> {
  let entries: string[];
  try {
    entries = await readdir(CASES_DIR);
  } catch (cause) {
    throw new StructuralError(
      `could not read cases directory ${CASES_DIR}: ${describe(cause)}`,
    );
  }

  const jsonFiles = entries.filter((f) => f.toLowerCase().endsWith(".json")).sort();
  if (jsonFiles.length === 0) {
    throw new StructuralError(`no *.json case files found in ${CASES_DIR}`);
  }

  const loaded: LoadedFile[] = [];
  const seenIds = new Set<string>();

  for (const file of jsonFiles) {
    const fullPath = join(CASES_DIR, file);

    let raw: string;
    try {
      raw = await readFile(fullPath, "utf8");
    } catch (cause) {
      throw new StructuralError(`could not read ${file}: ${describe(cause)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new StructuralError(`invalid JSON in ${file}: ${describe(cause)}`);
    }

    const result = EvalCaseFile.safeParse(parsed);
    if (!result.success) {
      throw new StructuralError(
        `schema validation failed for ${file}:\n${formatZodError(result.error)}`,
      );
    }

    for (const c of result.data) {
      if (seenIds.has(c.id)) {
        throw new StructuralError(`duplicate case id "${c.id}" (in ${file})`);
      }
      seenIds.add(c.id);
    }

    loaded.push({ file, cases: result.data });
  }

  return loaded;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * Render a compact summary table of results.
 */
function printSummary(results: EvalResult[]): void {
  const idWidth = Math.max(2, ...results.map((r) => r.caseId.length));
  const header = `${pad("ID", idWidth)}  RESULT  DETAIL`;
  const rule = "-".repeat(header.length);

   
  console.log(rule);
   
  console.log(header);
   
  console.log(rule);
  for (const r of results) {
    const mark = r.passed ? "PASS  " : "FAIL  ";
     
    console.log(`${pad(r.caseId, idWidth)}  ${mark}  ${r.detail}`);
  }
   
  console.log(rule);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  // Minimal arg handling: support a --help flag and ignore everything else so
  // the script stays dependency-light. Filtering by id can be added in Phase 1.
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
     
    console.log(
      [
        "Usage: tsx evals/run.ts",
        "",
        "Loads evals/cases/*.json, validates them against the EvalCase schema,",
        "and runs each case through the target function.",
        "",
        "TARGET (pluggable via env):",
        "  default (offline) — a dependency-free stub target; needs no DB/LLM.",
        "                      Case failures are tolerated; only structural errors",
        "                      (bad JSON / schema) exit non-zero.",
        "  EVAL_LIVE=1 + DATABASE_URL — build the REAL @vta/core pipeline against a",
        "                      migrated + seeded course DB with a configured LLM.",
        "                      Failing cases gate CI in this mode.",
        "",
        "Env flags:",
        "  EVAL_LIVE=1            enable the live target (also requires DATABASE_URL).",
        "  DATABASE_URL=...       Postgres URL for the seeded course (live mode).",
        "  EVAL_COURSE_ID=...     seeded course id to target (default 'eval-course').",
        "  LLM_PROFILE=dev|prod   LLM role→model profile (default 'dev').",
        "  FAIL_ON_CASE_FAILURE=1 force gating on case failures (default: on in live",
        "                         mode, off offline).",
      ].join("\n"),
    );
    return 0;
  }

  let loaded: LoadedFile[];
  try {
    loaded = await loadCases();
  } catch (err) {
    if (err instanceof StructuralError) {
       
      console.error(`\nSTRUCTURAL ERROR: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  const target = await makeTarget();
  const results: EvalResult[] = [];

  for (const { file, cases } of loaded) {
    for (const c of cases) {
      let reply: TargetReply;
      try {
        reply = await target(c.input);
      } catch (cause) {
        // A target throwing is treated as a (non-structural) case failure.
        results.push({
          caseId: c.id,
          passed: false,
          detail: `target threw while handling case (from ${file}): ${describe(cause)}`,
        });
        continue;
      }
      results.push(assertCase(c, reply));
    }
  }

  printSummary(results);

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;


  console.log(
    `\n${passed}/${total} cases passed (${failed} failed). ` +
      `[target: ${LIVE_MODE ? "live @vta/core pipeline" : "offline stub"}]`,
  );

  if (FAIL_ON_CASE_FAILURE && failed > 0) {

    console.error("Failing because one or more cases did not pass.");
    return 1;
  }

  if (!FAIL_ON_CASE_FAILURE && failed > 0) {

    console.log(
      "\nNote: case failures above are tolerated because the target is the " +
        "offline stub. Run with EVAL_LIVE=1 + DATABASE_URL (seeded course) to " +
        "exercise the real pipeline, or set FAIL_ON_CASE_FAILURE=1 to gate CI.",
    );
  }

  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // Unexpected error: surface it and fail hard.
     
    console.error("UNEXPECTED ERROR:", err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 2;
  },
);
