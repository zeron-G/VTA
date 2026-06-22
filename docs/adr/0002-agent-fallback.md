# ADR 0002: Ordered, permission-monotonic agent fallback

Status: Accepted

## Decision

Use this reasoning order:

1. Native VTA agent.
2. Codex non-interactive worker.
3. OpenClaw emergency worker.

Fail over the current request immediately for timeout, authentication,
rate-limit, or backend-unavailable errors. Open a backend circuit after a
configurable consecutive-failure threshold. Never retry policy errors, invalid
requests, or partially executed side effects.

## Safety rule

Fallback is permission-monotonic: each lower tier receives the same or a
smaller capability envelope and the same or a smaller data class. It can never
gain tools, network destinations, files, or credentials.
