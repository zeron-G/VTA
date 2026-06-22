# Current State

Last reviewed: 2026-06-22 against package version `2.0.0`.

VirtualTeachingAssistant currently has two code paths with different maturity
and responsibilities:

1. `virtual_teaching_assistant` is the V2 Python platform foundation. It defines
   the domain, policy, fallback, approval, extension, health, audit, and adapter
   boundaries. It is tested as a library but does not yet have a complete
   network service or production composition root.
2. `course_ta_deployer` is the original OpenClaw compatibility package. It can
   configure a concrete Canvas/Discord/OpenClaw teaching assistant, but it does
   not gain the V2 isolation and approval architecture merely by living in the
   same distribution.

## Implemented V2 foundation

| Capability | Source | Evidence and limits |
|---|---|---|
| Immutable domain records | `virtual_teaching_assistant/domain/models.py` | Validates identifiers, content size, timezone, metadata bounds; mappings are copied and read-only |
| Safe error taxonomy | `domain/errors.py` | Separates authentication, rate limit, timeout, unavailable, invalid request, policy, safety, and internal failures |
| Role/mode policy | `orchestration/policy.py` | Denies highly restricted input, blocks student restricted input and administration, strips side effects |
| Circuit breaker | `orchestration/circuit_breaker.py` | Closed/open/half-open state with threshold, recovery timeout, and single half-open trial |
| Agent fallback | `orchestration/fallback.py` | Orders by `AgentTier`; enforces timeout, data ceiling, capability intersection, and retry allowlist |
| Teaching service | `orchestration/service.py` | Runs orchestration and emits minimized success/failure audit events |
| Approval coordinator | `orchestration/actions.py` | Students cannot submit effects; high-risk actions require two distinct approvers; execution is idempotent per approval ID |
| Codex CLI adapter | `infrastructure/agents/codex_cli.py` | Prompt over stdin, ephemeral session, JSONL output, read-only sandbox, ignored user config, bounded process |
| Process boundary | `infrastructure/agents/process.py` | Minimal environment allowlist, timeout/kill, output bounds; it is not a container sandbox |
| LLM failover | `infrastructure/auth/failover.py` | Production eligibility, data ceilings, timeouts, circuit breakers, retry taxonomy |
| Official OpenAI transport | `infrastructure/auth/transports.py` | Async Responses API adapter with `store=False`; requires operator-supplied client/credentials |
| Experimental OAuth transport | `infrastructure/auth/transports.py` | Lazy optional `codex_oauth` adapter; marked non-production |
| Skill registry | `skills/registry.py` | Validates trusted `skill.json` manifests, entrypoint containment, version and capability fields |
| Activity registry | `activities/registry.py` | Validates plugin contract against descriptor; no concrete classroom activity ships |
| Channel registry | `infrastructure/channels/registry.py` | Registers adapters and prevents duplicate names; no V2 Discord adapter ships |
| Health supervisor | `infrastructure/observability/health.py` | Runs bounded concurrent probes and reports aggregate status |
| Audit sinks | `infrastructure/observability/audit.py` | In-memory and owner-mode JSONL sinks with recursive secret-key redaction |
| Runtime configuration | `runtime/config.py` | Strict environment parsing and production rejection of experimental OAuth/unisolated workers |
| Diagnostic CLI | `cli.py` | `version`, `architecture`, `config-check`, and local `self-check` |

Automated coverage is under `tests/test_platform_*.py`. The tests use fakes and
do not prove live provider compatibility, process isolation, throughput, or
institutional suitability.

## Compatibility capabilities

The original package under `course_ta_deployer/` provides:

- environment-file parsing without shell interpolation;
- a repeatable/dry-run OpenClaw installation and profile builder;
- installation of the bundled `course-ta` skill;
- Canvas course synchronization and local course-material indexing helpers;
- Discord guild/channel allowlist and mention-gating configuration;
- online/offline checks for Python, Node, OpenClaw, Canvas authentication,
  Canvas course visibility, Discord route visibility, model access, gateway,
  and memory indexing;
- secret redaction in configuration and command output.

These behaviors are compatibility features. The V2 `TeachingService` is not yet
wired into the legacy Discord gateway, Canvas helpers, or OpenClaw profile.

## Contract-only surfaces

- `ChannelAdapter`: normalize and deliver methods exist, but no V2 channel
  implementation verifies Discord/webhook signatures or delivers responses.
- `NativeAgentEngine`: protocol and wrapper exist, but no retriever, planner,
  prompt composer, verifier, or model loop exists.
- `OpenClawClient`: protocol and V2 backend wrapper exist, but no safe RPC client
  is included. The CLI was intentionally not used because it exposes prompt
  text in process arguments.
- `ActivityPlugin`: lifecycle contract exists, but games, debates, simulations,
  live analysis, and recap workflows are not implemented.
- `ActionExecutor`: typed execution boundary exists, but no V2 Canvas or Discord
  mutation executor is registered.
- `SkillProvider`: Python protocol exists. The bundled skill is discovered by
  manifest; a runtime prompt-composition pipeline is not implemented.

## Planned platform components

- Authenticated HTTP/event ingress and provider-signature verification.
- Durable provider-event idempotency and transactional delivery outbox.
- Concrete V2 Discord and Canvas read adapters.
- Native agent retrieval, prompt composition, response verification, and evals.
- Durable Postgres approval/state stores and Redis/queue infrastructure where
  justified by measured load.
- Isolated Codex/OpenClaw worker services with explicit egress and filesystem
  policy.
- Metrics, traces, alert routing, dashboards, backup/restore, and disaster
  recovery exercises.
- Instructor console, kill switch, step-up approval, and action reconciliation.
- Live-class ingestion, recap review/publication, and classroom activities.

## Institutional gates

Code cannot resolve these questions alone:

- Carey/JHU SSO, course membership, staff roles, service identities, and
  deprovisioning.
- FERPA/privacy analysis, records classification, retention/deletion, legal
  basis, vendor review, and cross-border processing constraints.
- Accessibility standards and student-facing support procedures.
- Approved model/provider usage, incident response, audit access, and security
  operations ownership.
- Course selection, instructor consent, student notice, opt-out/escalation, and
  teaching-quality evaluation criteria.

These gates are tracked in `issues/0001-production-identity-and-data-review.md`
and related issues. Until closed, use only synthetic data in development.

## Important limitations

- `VTA_CODEX_ISOLATED=true` and `VTA_OPENCLAW_ISOLATED=true` are operator
  assertions checked by configuration; they do not create isolation.
- The in-memory approval store is process-local and not durable or safe for
  multiple replicas.
- JSONL audit output is append-only within one process but is not an enterprise
  immutable audit system.
- Circuit-breaker state is process-local.
- The committed safety eval file validates scenario coverage and schema; it does
  not execute a model or measure answer quality.
- The default agent names and model string are configuration defaults, not a
  promise that a local executable or provider is available.
