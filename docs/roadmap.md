# Roadmap

The roadmap is ordered by risk reduction and evidence, not feature visibility.
Dates are intentionally absent until owners and institutional dependencies are
known.

## Phase 0: Framework foundation

**Status: implemented in version 2.0.0.**

- Python domain and protocol boundaries.
- Role/mode/data policy and reasoning-only capability envelope.
- Permission-monotonic agent/credential fallback with circuits and timeouts.
- Restricted Codex adapter and safe OpenClaw/native boundaries.
- Proposal/approval separation and high-risk two-person rule.
- Minimized audit, health supervision, skill/activity/channel registries.
- Architecture, threat, ADR, eval-fixture, security, build, and CI gates.

Exit evidence is the public CI pipeline and V2 unit suite. This phase establishes
design constraints; it does not provide a complete student service.

## Phase 1: Institution-neutral integration runtime

Build the missing runtime without real student data:

- composition root and authenticated HTTP/event API;
- provider event verification and durable idempotency;
- concrete V2 Discord adapter and Canvas read adapter;
- course-scoped retrieval/index interface;
- native engine skeleton with versioned skill composition and output verifier;
- Postgres state/approval/outbox implementation;
- safe model gateway composition and budget controls;
- container/service isolation for optional agent workers;
- metrics, traces, health endpoints, and local integration environment.

Exit criteria: synthetic end-to-end Q&A, replay/delivery tests, failure injection,
restore test, security review, and no automatic external writes.

## Phase 2: Teaching-quality and safety evaluation

- Institution-approved, de-identified representative task set.
- Rubrics for grounding, correctness, pedagogy, academic integrity, refusal,
  escalation, citation, accessibility, latency, and cost.
- Prompt injection, cross-course isolation, tool denial, outage, retry storm, and
  adversarial document tests.
- Baseline comparison across native, Codex, and OpenClaw tiers.
- Release thresholds and rollback criteria.

Exit criteria: documented evaluator agreement, reproducible eval runner,
statistically meaningful baseline, and zero unresolved critical safety cases.

## Phase 3: Institutional readiness

Tracked primarily by `issues/0001-production-identity-and-data-review.md` and
`issues/0003-isolate-agent-workers.md`:

- Carey/JHU SSO, course membership, RBAC, service identities, and offboarding;
- approved secret manager, provider accounts, and credential rotation;
- privacy/data-flow assessment, retention/deletion, records and vendor review;
- accessibility and student support review;
- incident response, operational ownership, alerting, and audit access;
- threat-model review, penetration testing, dependency/SBOM policy;
- instructor console, kill switch, escalation, and pilot consent process.

Exit criteria: recorded institutional approvals and tested operational controls.

## Phase 4: Read-only controlled pilot

- One explicitly approved course/section.
- Allowlisted users/channels and published student notice.
- Q&A and course navigation only.
- Instructor-visible escalation and feedback.
- No agent-triggered Canvas/Discord mutations.
- Daily review of quality, denials, incidents, latency, and cost.

Exit criteria: agreed pilot period completed, no unresolved security/privacy
incident, teaching-quality target met, rollback demonstrated.

## Phase 5: Reviewed teaching workflows

Add one workflow at a time behind human approval:

1. post-class recap drafting and instructor publication;
2. approved announcement/message proposals;
3. live-class bounded analysis with explicit recording/transcript governance;
4. classroom activities such as debates, simulations, or quiz games;
5. carefully reviewed administrative actions, starting with low-risk reversible
   operations.

Grades, enrollment, assessment publication, accommodations, and disciplinary
records remain high-risk. Some may remain permanently outside agent workflows.

## Phase 6: Multi-channel and scale-out

Only after measured need:

- school app/web adapters;
- multi-course/term lifecycle automation;
- stateless ingress replicas and worker pools;
- separate indexing and live-event services;
- regional/availability architecture consistent with institutional policy.

Scaling does not relax tenant isolation, approval, audit, or data-minimization
requirements.

## Contribution priorities

The next engineering work should prioritize Phase 1 foundations and Phase 2
evaluation infrastructure before adding visible classroom features. A feature is
not ready because an LLM can demonstrate it; it is ready when contracts,
authorization, failure behavior, tests, observability, and rollback are defined.
