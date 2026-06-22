# Architecture Decision Records

ADRs record decisions that constrain future implementation. Accepted decisions
remain authoritative until superseded by a later ADR.

| ADR | Status | Decision |
|---|---|---|
| [0001](0001-modular-monolith.md) | Accepted | Begin with a Python modular monolith and extract high-risk workers deliberately |
| [0002](0002-agent-fallback.md) | Accepted | Native to Codex to OpenClaw fallback is permission-monotonic |
| [0003](0003-llm-authentication.md) | Accepted | Use official production identity; personal OAuth is experimental only |
| [0004](0004-codex-worker.md) | Accepted | Codex is a restricted worker and never runs in yolo mode |
| [0005](0005-side-effects.md) | Accepted | Reasoning produces proposals; separate approval/execution owns effects |

Use [0000-template](0000-template.md) for a new decision. Include context,
decision, alternatives, consequences, migration/rollback, security impact, and
status. Do not rewrite an accepted decision to hide history; supersede it.
