# ADR 0004: Codex is a restricted worker, never yolo

Status: Accepted

## Decision

The Codex adapter uses `codex exec` JSONL with an ephemeral session, read-only
sandbox, no interactive approvals, ignored user config, an isolated working
directory, a minimal environment, stdin prompts, and a hard process timeout.

Do not use `--yolo`, `danger-full-access`, or a writable course repository for
student Q&A. For a richer future integration, prefer local stdio `codex
app-server`; do not expose its experimental WebSocket listener remotely.

## Consequences

- Codex produces text/tool proposals only.
- It cannot directly publish, grade, message, or mutate Canvas.
- The worker process must run in a dedicated OS sandbox/container or equivalent
  isolated service boundary before production enablement.
