# Extending VirtualTeachingAssistant

Extensions implement typed ports; they do not bypass policy. Keep provider
details in infrastructure modules and preserve domain/orchestration independence.

## Add a communication channel

Implement `ChannelAdapter` from `ports/channels.py`:

- `normalize(payload)` authenticates/validates provider data outside the domain
  model, maps trusted tenant/course/actor context, and returns `TeachingRequest`;
- `deliver(response, destination)` sends idempotently and returns an external
  reference;
- `probe()` performs a bounded, non-mutating health check.

Required controls include signature verification, timestamp/replay rejection,
payload limits, bot/self-message suppression, explicit tenant/course routing,
destination allowlists, rate limiting, safe errors, and delivery idempotency.
Register it with `ChannelRegistry`; registration only makes it discoverable.

## Add an agent backend

Implement `AgentBackend` with a unique name, `AgentTier`, capability set, maximum
data classification, `invoke`, and `probe`.

The orchestrator will intersect declared backend authority with platform policy.
The backend must still:

- accept only the supplied request/envelope;
- keep prompts out of process arguments and logs;
- enforce time/output/resource bounds;
- return `BackendFailure` with a safe category and retryability;
- never execute or approve a side effect;
- report citations/proposals through domain types.

Do not add a new failure category to the automatic fallback set without a threat
analysis and regression tests.

## Implement the native engine

`NativeAgentEngine.generate()` is the intended long-term Python-native entry
point. A complete engine should keep these stages separately testable:

1. course-scoped retrieval;
2. prompt/skill composition with version metadata;
3. LLM transport selection;
4. structured response parsing;
5. policy and citation verification;
6. answer/proposal construction;
7. eval and telemetry emission.

The engine must not own channel delivery or action execution.

## Add an LLM transport

Implement `LLMTransport` with `name`, `production_allowed`, maximum data class,
`complete`, and `probe`. Map provider exceptions into `TransportFailure` without
including secrets, raw prompts, or provider bodies in safe messages.

Add a `TransportRegistration` with a circuit breaker and timeout. Production
composition rejects transports whose `production_allowed` flag is false.

Authentication diversity is not automatically security strength. Document
identity ownership, refresh/revocation, storage, provider support, data handling,
and failure semantics for every transport.

## Add or change a teaching skill

A packaged skill directory needs `SKILL.md` and `skill.json`. The manifest
declares:

- stable ID and semantic version;
- entrypoint contained inside the skill directory;
- trusted status;
- maximum data classification;
- supported modes;
- requested capabilities.

Treat skill text as executable policy: review diffs, validate it, update safety
and teaching-quality evals, and preserve rollback to a prior version. Retrieved
course content is untrusted data and cannot override the platform envelope.

## Add a classroom activity

Implement `ActivityPlugin` and register it with an `ActivityDescriptor` whose
modes and required capabilities exactly match the plugin.

Activities should define explicit state, transitions, participant visibility,
instructor controls, time/resource bounds, cancellation, recovery, and audit
events. Team assignment, scoring, publication, or messaging must become action
proposals when they affect external state.

## Add a side-effect executor

Implement `ActionExecutor` for one exact `action_type`. It receives a validated
proposal and idempotency key only after approval.

Production executors require:

- action-specific schema validation and target scoping;
- fresh authorization/step-up policy where necessary;
- idempotent provider calls and conflict detection;
- safe timeout/retry semantics;
- durable outbox or equivalent transaction boundary;
- external result reference and reconciliation;
- minimized audit without sensitive payloads.

Never expose a generic shell, HTTP, or arbitrary Canvas executor to an agent.

## Add health or audit integration

Health probes must be bounded and non-mutating. A failed optional probe may
degrade aggregate state; a failed critical probe fails it. Do not send test
messages or write Canvas objects from a health endpoint.

Audit sinks receive already minimized `AuditEvent` objects and must retain
redaction, access control, append integrity, retention, and deletion policy.

## Review checklist

- Does the extension stay behind the correct port?
- Is every capability/data ceiling explicit and least-privileged?
- Are external inputs treated as untrusted?
- Are time, output, concurrency, and retry bounds enforced?
- Are failures categorized without leaking sensitive content?
- Are side effects proposed rather than executed by an agent?
- Are tests/evals and current-state docs updated?
- Is production composition gated when the implementation is experimental?
