# Contracts Reference

The V2 public architecture is expressed as immutable dataclasses, enums, and
Python `Protocol` interfaces. Source remains authoritative; this document
explains their intended semantics.

## Domain enums

### Actor roles

`student`, `course_staff`, `instructor`, `administrator`, and `service` describe
policy inputs. A role value is not authentication evidence; trusted ingress must
derive it from an approved identity and course-membership source.

### Interaction modes

- `question_answer`
- `live_class`
- `post_class_recap`
- `activity`
- `administration`

Modes select a bounded capability profile. They are not free-form intent labels.

### Data classifications

Ordered from least to most sensitive: `PUBLIC`, `INTERNAL`, `RESTRICTED`, and
`HIGHLY_RESTRICTED`. Backends and transports declare a maximum. Policy currently
blocks all highly restricted requests and student-originated restricted input.

### Agent tiers

`NATIVE=1`, `CODEX=2`, `OPENCLAW=3`. Numeric order controls fallback priority;
it does not grant higher tiers more permission.

### Capabilities

Reasoning/read/draft capabilities are distinct from side effects. The current
set includes `reason`, `course.read`, `canvas.read`, `response.draft`, live/recap
and activity capabilities, plus `discord.send`, `canvas.write`, and
`config.write`. Policy removes the three side effects before agent invocation.

## Core records

### `TeachingRequest`

Carries tenant/course/actor/channel, trusted role and mode, content, data class,
request/trace/idempotency IDs, event time, and bounded metadata. It is immutable
after validation.

### `CapabilityEnvelope`

Carries the exact capability set, maximum data class, and side-effect flag for
one invocation. `restrict()` can only intersect capabilities, lower data access,
and preserve an already allowed side-effect flag; current policy never sets it.

### `AgentResult` and `TeachingResponse`

`AgentResult` is backend output: content, citations, proposals, model, and usage.
`TeachingResponse` adds request/trace linkage, backend/tier, degraded status,
and the sequence of attempts.

### `ActionProposal` and `ApprovalRecord`

A proposal describes an action type, target, and arguments. It is not
authorization. `ApprovalRecord` tracks requester, required approvals, distinct
approvers, state, and external execution reference.

### `HealthReport`

Reports component, `ok/degraded/failed/disabled`, check time, latency, safe
detail, criticality, and bounded metadata.

## Port protocols

| Protocol | Responsibility | Must not assume |
|---|---|---|
| `AgentBackend` | Run reasoning under an envelope and report health | Permission to deliver or mutate |
| `NativeAgentEngine` | Generate one agent result | Channel, approval, or storage ownership |
| `ChannelAdapter` | Normalize trusted provider events, deliver responses, probe | That payload roles/tenant are truthful without verification |
| `LLMTransport` | Complete an LLM request and probe provider | Production eligibility beyond its declaration |
| `SkillProvider` | Decide support and provide versioned instructions | Authority beyond requested capabilities |
| `ActivityPlugin` | Start/handle/stop bounded activity state | Permission to publish or score externally |
| `ApprovalStore` | Create/get/update approval records | In-memory implementation is durable |
| `ActionExecutor` | Execute one exact action type idempotently | Agent output is already safe/authorized |
| `AuditSink` | Persist minimized audit events | Permission to add raw content |
| `HealthProbe` | Perform bounded non-mutating checks | Permission to send test messages/writes |

## Failure contracts

`VTAError.safe_message` is intended for bounded operator context. It must not
contain provider bodies, prompts, credentials, personal data, or filesystem
secrets.

- `ConfigurationError`: caller/configuration defect.
- `PolicyDenied`: intentional policy rejection.
- `BackendFailure`: agent runtime failure with backend and retryability.
- `TransportFailure`: model transport failure with transport and retryability.
- `NoBackendAvailable`: all eligible agent paths were skipped or failed.

Retryability and category are both required for fallback. A retryable flag alone
cannot make policy/invalid/safety failures eligible.

## Compatibility stability

Version `2.0.0` is a foundation release, not a declared stable public API. Until
a formal compatibility policy is adopted, changes to enums, dataclass fields,
protocols, manifest schema, failure mapping, or policy behavior require an ADR
or spec, tests, migration notes, and a version decision.
