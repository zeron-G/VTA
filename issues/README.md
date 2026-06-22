# Local Engineering Backlog

This directory preserves architecture-stage work that must remain visible even
when it has not yet been transferred to GitHub Issues.

## Open production-readiness work

| Issue | Priority area |
|---|---|
| [0001](0001-production-identity-and-data-review.md) | Institutional identity, authorization, privacy, and data governance |
| [0002](0002-production-state-and-outbox.md) | Durable state, idempotency, outbox, and recovery |
| [0003](0003-isolate-agent-workers.md) | Codex/OpenClaw process, filesystem, secret, and network isolation |
| [0004](0004-build-approved-evaluation-suite.md) | Approved quality, safety, robustness, latency, and cost evaluation |

Create one issue per actionable problem. Include impact, evidence, affected
modules, acceptance criteria, verification, dependencies, and rollback concerns.
Use P0-P3 severity and distinguish a reproduced bug from an investigation or
planned feature.

Closing a Markdown checklist does not create institutional approval. Record the
external decision/owner and link only non-sensitive evidence.
