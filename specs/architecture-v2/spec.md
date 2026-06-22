# Architecture V2 Specification

## Goal

Evolve the deployment-oriented VTA repository into VirtualTeachingAssistant, a
secure, extensible teaching platform suitable for a controlled Carey Business
School Linux pilot.

## Required behavior

- Normalize Discord and future channels into one validated request contract.
- Enforce tenant/course isolation and role/data-class policy before agent use.
- Route side-effect-free reasoning through native, Codex, then OpenClaw tiers.
- Use circuit breakers, hard timeouts, bounded retries, and traceable fallback.
- Route official API-key and approved enterprise credentials independently;
  keep personal OAuth experimental and disabled in production by default.
- Treat all agent outputs as proposals and gate side effects separately.
- Register skills and classroom activities through typed, versioned manifests.
- Produce minimized audit events and component health snapshots.
- Preserve the existing Course TA deployer as a migration compatibility layer.

## Security invariants

- No secret or raw student content in logs, exceptions, process arguments, or
  health responses.
- No automatic write action from a student request.
- No permission expansion during backend or credential fallback.
- No production yolo/full-access Codex configuration.
- No production personal OAuth cache.
- No cross-course index, cache, conversation, or idempotency key.

## Public contracts

- `TeachingRequest` and `TeachingResponse` domain records.
- `AgentBackend`, `LLMTransport`, `ChannelAdapter`, `HealthProbe`, `AuditSink`,
  `SkillProvider`, and `ActivityPlugin` ports.
- `FallbackOrchestrator`, `CredentialFailoverRouter`, `PolicyEngine`, and
  `HealthSupervisor` services.
- Environment-backed `PlatformConfig` with production safety validation.

## Acceptance criteria for this increment

- Domain/port/orchestration boundaries exist and are independently tested.
- Native/Codex/OpenClaw ordered fallback and circuit recovery are testable with
  injected clocks and failures.
- Codex subprocess construction proves read-only, ephemeral, JSONL, stdin, and
  minimal-environment behavior and rejects yolo flags.
- Experimental OAuth cannot be enabled in production without an explicit
  unsafe override that itself fails normal config validation.
- Audit output contains digests/lengths but not raw actor ids or prompts.
- Future channel, skill, and classroom activity implementations can register
  without changing orchestration code.
- Existing tests remain green and CI adds architecture tests.

## Deferred production gates

- Carey/JHU identity provider and instructor/admin SSO.
- Institution-approved secrets manager, database, queue, and monitoring stack.
- Privacy, accessibility, records-retention, legal, and procurement review.
- Real Discord/Canvas sandbox integration and load tests.
- Native agent implementation and evaluation corpus using approved course data.
- Production OpenClaw RPC adapter without prompt-in-command-line exposure.
