/**
 * `@vta/tools` — the agent's LEAST-PRIVILEGE, READ-ONLY tool set.
 *
 * DESIGN RULE (load-bearing, do not relax):
 *   There is NO 'send' tool and NO write/exec/filesystem tool. A tool may ONLY
 *   read course information. Producing the answer text is the model's job;
 *   DELIVERING it is the core/adapter's job, AFTER egress governance. So the
 *   tool surface must never let the model emit to a channel or mutate anything.
 *
 * The tool contract is framework-agnostic (NOT tied to Pi or any agent
 * framework). `parameters` is a plain zod schema; a later wave converts it to
 * the Pi tool format, and the governance tool-gate wraps `execute`. Both can
 * therefore wrap these tools without this package knowing about either.
 *
 * Tenancy: every tool is tenant-scoped via the injected `ToolContext`, NEVER
 * via its arguments. A tool resolves the course it may read from `ctx.courseId`
 * and ignores any course-like value the model might smuggle in through `args`.
 */

import type { z } from 'zod';
import type { CourseId } from '@vta/shared';
import type { CourseRole } from '@vta/shared';

/**
 * Per-request execution scope, injected by the caller (core/adapter), never
 * supplied by the model. This is the ONLY source of tenant + caller identity a
 * tool is allowed to trust:
 *   - `courseId` — the tenant boundary; the sole course a tool may read.
 *   - `role`     — the caller's membership tier within that course, available
 *                  for future per-role gating (e.g. hiding solutions from
 *                  students). Tools must not widen access beyond `courseId`.
 */
export interface ToolContext {
  readonly courseId: CourseId;
  readonly role: CourseRole;
}

/**
 * The outcome of a tool call.
 *   - `content` is the text handed back to the model — it must be self-contained
 *     and ground-able (e.g. it carries citations inline) because the model only
 *     ever sees this string, not `data`.
 *   - `data` is optional structured output for non-model consumers (audit log,
 *     adapter, tests). It is NOT shown to the model.
 */
export interface ToolResult {
  readonly content: string;
  readonly data?: unknown;
}

/**
 * A framework-agnostic, read-only tool the agent may call.
 *
 * @typeParam A - the validated argument shape, inferred from `parameters`.
 *
 *   - `name`        — stable identifier the model and the tool-gate reference.
 *   - `description` — natural-language guidance the model uses to pick the tool.
 *   - `parameters`  — a zod schema describing/validating the arguments. Kept as
 *                     raw zod (not a Pi/JSON-Schema shape) so this package stays
 *                     framework-agnostic; the conversion happens downstream.
 *   - `execute`     — runs the tool. `args` are the already-parsed arguments;
 *                     `ctx` carries the tenant + caller scope. It must perform
 *                     READS ONLY and must scope every read to `ctx.courseId`.
 */
export interface VtaTool<A = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodType<A>;
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}
