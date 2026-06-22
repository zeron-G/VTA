# Operations and Observability

## Current observability foundation

### Health supervision

`HealthSupervisor` runs registered `HealthProbe` implementations concurrently
with per-probe timeouts. Each registration declares whether it is critical.

Aggregate status is:

- `failed` when any critical probe fails;
- `degraded` when an optional probe fails or reports degraded;
- `ok` when all enabled probes are healthy.

Timeout and unexpected-exception details are normalized to safe messages. The
current supervisor is a library component; no HTTP `/health` endpoint, scheduler,
metrics export, or alert integration ships.

`virtual-ta self-check` is separate. It is a local diagnostic that checks Python,
skill discovery, and enabled executable presence without network calls.

The legacy `course-ta-deploy check` has online and offline checks for its own
OpenClaw/Canvas/Discord/model deployment. It uses read-only Canvas/Discord HTTP
operations and must never send a test Discord message.

### Minimized audit

`TeachingService` emits one interaction event on success or failure. The
`JsonlAuditSink` writes owner-mode append-only JSONL and recursively redacts
fields whose names look like tokens, secrets, passwords, authorization, API
keys, or auth data.

Audit intentionally excludes raw prompts, answer content, actor identifiers,
tokens, and provider bodies. HMAC digests support bounded correlation without
publishing raw identifiers. HMAC keys need managed storage and rotation in real
deployments.

## Operational signals required for a pilot

The following are target requirements, not current implementations:

- request counts and latency by channel/mode/backend/outcome;
- fallback and circuit state by backend and transport;
- policy denials by safe category;
- queue age/depth, duplicate suppression, delivery/executor reconciliation;
- model token/cost budgets and timeout rates;
- retrieval freshness and citation coverage;
- approval age and high-risk action counts;
- health state transitions and deployment/version metadata;
- privacy-safe teaching-quality and escalation indicators.

Labels must avoid raw course titles, student identifiers, prompt fragments,
tokens, or unbounded provider error text.

## Suggested service objectives

Actual thresholds require a pilot baseline and teaching-owner agreement. Define
separate objectives for:

- platform availability;
- response latency by interaction mode;
- successful grounded-response rate;
- side-effect correctness/idempotency;
- data isolation and unauthorized-action rate (target zero);
- recovery time after backend/provider failure;
- Canvas index freshness.

Do not hide unsafe or low-quality responses inside an availability metric.

## Alert classes

- **Security:** cross-tenant anomaly, credential failure spike, policy bypass,
  unexpected write, audit gap.
- **Availability:** all agent backends unavailable, critical dependency failed,
  queue stalled, delivery backlog.
- **Quality:** citation collapse, evaluation regression, abnormal escalation or
  refusal pattern.
- **Cost/capacity:** rate-limit growth, token budget breach, runaway activity,
  worker saturation.

Alerts need owners, severity, paging windows, safe context, and runbook links.
Raw prompts or student data must not be inserted into notifications.

## Degradation policy

Fallback is allowed only for side-effect-free reasoning and only for retryable
availability categories. A backend failure cannot broaden capabilities or data
access. If no eligible backend succeeds, fail closed with a safe service message.

Disable automated side effects independently from Q&A. Disable a compromised or
misbehaving backend/transport without requiring a full service shutdown. See the
[degraded-mode runbook](../runbooks/degraded-mode.md).

## Incident evidence

Preserve bounded request/trace references, version/deployment identity, safe
failure categories, circuit transitions, approval/execution references, and
provider request IDs where policy allows. Store sensitive evidence in approved
incident systems, not public GitHub issues or this repository.

## Current gaps

- No metrics/tracing exporter.
- No HTTP health/readiness endpoints.
- No central audit integrity/retention system.
- No alert routing or on-call ownership.
- No durable state/outbox reconciliation.
- No backup/restore or disaster-recovery automation.
- No capacity/load baseline.

These gaps prevent a production-readiness claim even though local health and
audit components are implemented.
