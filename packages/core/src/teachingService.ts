/**
 * `TeachingService` — the channel-agnostic request orchestrator.
 *
 * This is the one place the whole Virtual Teaching Assistant pipeline is tied
 * together. Every channel adapter (Discord now; email/web later) normalizes its
 * native event into an {@link InboundRequest}, hands it to {@link handle}, and
 * renders the returned {@link OutboundReply}. The service never knows which
 * channel a message came from.
 *
 * THE PIPELINE (fixed order, never reordered):
 *   1. Load the course config and build a {@link GovernanceContext}.
 *   2. INGRESS  — inspect the raw inbound text. A block short-circuits to a
 *                 refusal WITHOUT ever calling the agent.
 *   3. AGENT    — answer the PII-redacted question.
 *   4. EGRESS   — the MANDATORY last gate. The reply's text/status/citations
 *                 come from the {@link EgressDecision}, NEVER the raw agent text.
 *   5. AUDIT    — append exactly one durable record. Runs on EVERY terminal path
 *                 (ingress-block, success, AND error).
 *   6. Return the {@link OutboundReply}.
 *
 * CARDINAL INVARIANTS (all enforced here, all load-bearing):
 *   (a) Egress runs on the agent output before EVERY non-ingress-blocked reply,
 *       and the reply is built from the EgressDecision — never the raw agent text.
 *   (b) `audit.append` runs on every terminal path, INCLUDING unexpected errors.
 *   (c) The stored question/answer are the redacted / egress-scanned versions,
 *       honoring the `@vta/audit` redaction invariant.
 *
 * FAIL-SAFE: the entire body is wrapped in try/catch. Any unexpected throw is
 * converted to a neutral `error` reply AND a best-effort `error` audit entry, so
 * a thrown error can never deliver an ungoverned answer.
 */

import type { ConversationTurn, InboundRequest, OutboundReply, Logger } from '@vta/shared';
import { createLogger, toError } from '@vta/shared';

import { verifyCitations } from './citationCheck.js';
import type { ResolvedCourseConfig } from '@vta/tenancy';
import type { GovernanceContext, IngressGovernor, EgressGovernor } from '@vta/governance';
import type { CourseAgent, AgentOutput } from '@vta/agent';
import type { AuditService, GovernanceVerdict } from '@vta/audit';

/**
 * Loads (and validates) a course's resolved configuration. The composition root
 * supplies a closure over the tenancy `loadCourseConfig` + a `Db`; the service
 * only needs the resolved config, not the data layer.
 */
export type ConfigLoader = (courseId: string) => Promise<ResolvedCourseConfig>;

/** Constructor dependencies for {@link TeachingService}. */
export interface TeachingServiceDeps {
  /** Resolves a course's `ResolvedCourseConfig` (ContentRules etc.). */
  readonly loadCourseConfig: ConfigLoader;
  /** INGRESS gate — prompt-injection block + input PII redaction. */
  readonly ingress: IngressGovernor;
  /** The governed, bounded answering agent (primary + fallback already composed). */
  readonly agent: CourseAgent;
  /** EGRESS gate — grounding, content boundaries, output PII scan, moderation. */
  readonly egress: EgressGovernor;
  /** Durable, append-only audit/disclosure log writer. */
  readonly audit: AuditService;
  readonly logger?: Logger;
}

/**
 * Neutral apology returned (and audited) when an UNEXPECTED error occurs. It
 * leaks nothing about the failure and carries the `error` status so adapters can
 * render it appropriately.
 */
const ERROR_REPLY_TEXT =
  'Sorry — something went wrong on my end and I couldn’t complete your request. Please try again in a moment.';

/** Most recent conversation turns to replay as context (bounds the model context). */
const MAX_HISTORY_TURNS = 12;
/** Per-turn character cap when replaying history. */
const MAX_HISTORY_TURN_CHARS = 2000;

export class TeachingService {
  private readonly loadCourseConfig: ConfigLoader;
  private readonly ingress: IngressGovernor;
  private readonly agent: CourseAgent;
  private readonly egress: EgressGovernor;
  private readonly audit: AuditService;
  private readonly log: Logger;

  constructor(deps: TeachingServiceDeps) {
    this.loadCourseConfig = deps.loadCourseConfig;
    this.ingress = deps.ingress;
    this.agent = deps.agent;
    this.egress = deps.egress;
    this.audit = deps.audit;
    this.log = deps.logger ?? createLogger({ name: 'teaching-service' });
  }

  /**
   * Run one inbound request through the full governed pipeline and return a
   * deliverable reply. Always audits; never lets an answer skip egress; never
   * lets a thrown error deliver an ungoverned answer.
   */
  async handle(request: InboundRequest): Promise<OutboundReply> {
    // The question we store in the audit log. Starts EMPTY (never the raw text)
    // so that if the pipeline throws BEFORE ingress redaction runs, no raw PII can
    // reach the disclosure log. Set to the ingress-REDACTED text once ingress
    // completes (redaction invariant c).
    let auditQuestion = '';
    // Verdicts accumulated as stages complete, so the error path records partial
    // progress (ingress / tool-gate / egress) rather than only a synthetic verdict.
    const collected: GovernanceVerdict[] = [];

    try {
      // (1) Resolve this course's policy and build the per-request context. The
      // governance context is the SOLE carrier of tenant + caller identity.
      const config = await this.loadCourseConfig(request.courseId);
      const govContext: GovernanceContext = {
        courseId: request.courseId,
        role: request.role,
        rules: config.contentRules,
        requestId: request.id,
      };

      // (2) INGRESS — inspect the UNTRUSTED inbound text before the model runs.
      const ingressDecision = await this.ingress.inspect(request.text, govContext);
      // The redacted text is what both the agent AND the audit log see.
      const redactedText = ingressDecision.redactedText;
      // Redaction has run — from here the audited question is the redacted text
      // (invariant c), and ingress verdicts survive even if a later stage throws.
      auditQuestion = redactedText;
      collected.push(...ingressDecision.verdicts);

      if (!ingressDecision.allow) {
        // Blocked at the door: build a refusal, AUDIT, and return WITHOUT ever
        // invoking the agent.
        const refusalText = ingressDecision.refusal ?? INGRESS_FALLBACK_REFUSAL;
        const reply: OutboundReply = {
          text: refusalText,
          status: 'refused',
          ...(request.threadId !== undefined ? { threadId: request.threadId } : {}),
        };
        await this.appendAudit(request, refusalText, 'refused', collected, redactedText);
        return reply;
      }

      // (3) AGENT — answer the redacted question within the governance context.
      // Prior conversation turns (if any) are PII-redacted here before the model
      // sees them, mirroring the ingress redaction applied to the live question.
      const history = await this.redactHistory(request.history);
      const agentOutput: AgentOutput = await this.agent.answer({
        govContext,
        question: redactedText,
        ...(request.locale !== undefined ? { locale: request.locale } : {}),
        ...(history.length > 0 ? { history } : {}),
      });
      collected.push(...agentOutput.governanceVerdicts);

      // (3b) CITATION VERIFICATION — deterministically strip any web URL the
      // model cited that is NOT one of the real sources the tools returned, so a
      // fabricated link can never reach a student. Runs before egress inspects
      // the text.
      const cited = verifyCitations(agentOutput.text, agentOutput.citations);
      if (cited.fabricatedCount > 0) {
        this.log.warn(
          { requestId: request.id, fabricated: cited.fabricatedCount },
          'stripped unverifiable citation URL(s) from the answer',
        );
        collected.push({
          stage: 'egress',
          check: 'citation.fabricated',
          decision: 'flag',
          reason: `removed ${cited.fabricatedCount} unverifiable source link(s) not returned by any tool`,
          at: new Date().toISOString(),
        });
      }

      // (4) EGRESS — the MANDATORY gate. This is the only place an answer becomes
      // deliverable. The reply text/status/citations come from the decision,
      // NEVER from the raw agent output.
      const egressDecision = await this.egress.inspect(cited.text, govContext, {
        citations: agentOutput.citations,
      });
      collected.push(...egressDecision.verdicts);

      // (5) AUDIT — one record, with the redacted question and the egress-scanned
      // answer, plus every verdict from ingress + agent tool-gate + egress.
      await this.appendAudit(request, egressDecision.text, egressDecision.status, collected, redactedText);

      // (6) Return — built entirely from the EgressDecision.
      return {
        text: egressDecision.text,
        status: egressDecision.status,
        citations: egressDecision.citations,
        ...(request.threadId !== undefined ? { threadId: request.threadId } : {}),
      };
    } catch (err) {
      // FAIL-SAFE: any unexpected throw becomes a neutral error reply. A throw
      // must NEVER deliver an ungoverned answer, and we still audit (best effort).
      const error = toError(err);
      this.log.error(
        { requestId: request.id, courseId: request.courseId, err: error.message },
        'teaching pipeline failed; returning safe error reply',
      );

      // Best-effort audit on the error path. The stored question is the redacted
      // text if ingress had run, else EMPTY (never raw PII). Verdicts collected
      // before the throw are preserved alongside the synthetic internal verdict.
      await this.bestEffortErrorAudit(request, auditQuestion, error, collected);

      return {
        text: ERROR_REPLY_TEXT,
        status: 'error',
        ...(request.threadId !== undefined ? { threadId: request.threadId } : {}),
      };
    }
  }

  /**
   * Bound and PII-redact prior conversation turns before they reach the model.
   * Keeps only the most recent {@link MAX_HISTORY_TURNS}; caps each turn's
   * length; re-redacts `user` turns through the ingress redactor (a redactor
   * failure DROPS that turn rather than replaying raw PII); passes `assistant`
   * turns through unchanged (they were egress-governed when first delivered).
   */
  private async redactHistory(
    history: readonly ConversationTurn[] | undefined,
  ): Promise<ConversationTurn[]> {
    if (history === undefined || history.length === 0) return [];
    const recent = history.slice(-MAX_HISTORY_TURNS);
    const out: ConversationTurn[] = [];
    for (const turn of recent) {
      const content = turn.content.slice(0, MAX_HISTORY_TURN_CHARS);
      if (content.trim() === '') continue;
      if (turn.role === 'assistant') {
        out.push({ role: 'assistant', content });
        continue;
      }
      try {
        out.push({ role: 'user', content: await this.ingress.redactText(content) });
      } catch (err) {
        this.log.warn(
          { err: toError(err).message },
          'dropping a history turn whose PII redaction failed',
        );
      }
    }
    return out;
  }

  /**
   * Append one audit entry. `question` MUST already be the redacted text and
   * `answer` the egress-scanned (or refusal/error) text — this method does not
   * redact. `userId`/`channel` are carried from the request.
   */
  private async appendAudit(
    request: InboundRequest,
    answer: string,
    status: OutboundReply['status'],
    verdicts: readonly GovernanceVerdict[],
    redactedQuestion: string,
  ): Promise<void> {
    await this.audit.append({
      courseId: request.courseId,
      userId: request.userId,
      channel: request.channel,
      requestId: request.id,
      question: redactedQuestion,
      answer,
      status,
      verdicts,
    });
  }

  /**
   * Audit the error terminal path. Failing to AUDIT must not mask the original
   * failure, so any error from the audit write itself is logged and swallowed —
   * the user still gets the safe error reply either way.
   */
  private async bestEffortErrorAudit(
    request: InboundRequest,
    redactedQuestion: string,
    cause: Error,
    collected: readonly GovernanceVerdict[],
  ): Promise<void> {
    try {
      await this.audit.append({
        courseId: request.courseId,
        userId: request.userId,
        channel: request.channel,
        requestId: request.id,
        question: redactedQuestion,
        answer: ERROR_REPLY_TEXT,
        status: 'error',
        verdicts: [
          ...collected,
          {
            stage: 'egress',
            check: 'internal',
            decision: 'block',
            reason: `pipeline error (fail-safe): ${cause.message}`,
            at: new Date().toISOString(),
          },
        ],
      });
    } catch (auditErr) {
      this.log.error(
        { requestId: request.id, err: toError(auditErr).message },
        'best-effort error audit also failed; original failure stands',
      );
    }
  }
}

/**
 * Fallback refusal text if an ingress block somehow omits its own refusal
 * message. `IngressGovernor` always supplies one today; this guards the type
 * (`refusal?` is optional) without leaking anything.
 */
const INGRESS_FALLBACK_REFUSAL =
  'I can only help with genuine questions about this course. Please rephrase your request.';
