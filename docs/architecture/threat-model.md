# Threat Model

## Protected assets

- Student identities, messages, submissions, attendance, grades, and rosters.
- Instructor-only material and future assessments.
- Canvas, Discord, OpenAI, Codex, gateway, and database credentials.
- Course routing, administrator identities, policy, prompts, and audit records.
- Availability and integrity of classroom activities and published content.

## Primary adversaries and failures

- A student attempting prompt injection, privilege escalation, or data
  extraction through Discord or course material.
- Malicious instructions embedded in Canvas pages, uploads, links, or live
  transcript content.
- A compromised agent backend or dependency attempting tool abuse or
  exfiltration.
- Credential theft from process arguments, environment inheritance, logs,
  images, backups, or support bundles.
- Cross-course data leakage caused by routing or cache-key mistakes.
- Duplicate provider events causing repeated messages or writes.
- An unavailable or rate-limited provider causing unsafe fallback behavior.
- An operator accidentally enabling a development backend in production.

## Controls

| Threat | Required control |
|---|---|
| Prompt injection | Treat retrieved content as data; immutable system policy; capability envelope; output verification |
| Cross-course leakage | Tenant/course required in every request and cache key; per-course index namespace; contract tests |
| Tool abuse | Agent cannot execute side effects; separate allowlisted executor; approval and idempotency |
| Credential leakage | External secret manager; allowlisted child environment; no secrets in argv/logs; owner-only files for development |
| Unsafe fallback | Equivalent or lower permissions only; circuit breaker; failure-category allowlist; trace every attempt |
| Replay/duplicates | Provider signature verification; event id store; transactional outbox for delivery and writes |
| Sensitive logging | HMAC actor references; content digests and lengths only; bounded structured fields; retention controls |
| Compromised worker | Dedicated service account/container; read-only root; no host socket; egress allowlist; CPU/memory/time limits |
| Unauthorized instructor action | Institutional SSO/RBAC; step-up approval; two-person review for bulk or grade-affecting actions |
| Live classroom disruption | Instructor kill switch; bounded queues; manual fallback; activity state checkpointing |

## Data classes

- **Public:** published course descriptions and public resources.
- **Internal:** enrolled-course materials and ordinary course Q&A.
- **Restricted:** identifiable student messages, submissions, attendance, and
  accommodations.
- **Highly restricted:** grades, disciplinary records, credentials, auth
  tokens, and security configuration.

Default agent access is Public + Internal. Restricted data requires an explicit
use-case policy. Highly restricted data never enters a general agent prompt.

## Explicitly forbidden production configurations

- Codex `--yolo`, `danger-full-access`, or bypassed approvals/sandbox.
- OpenClaw with host-wide filesystem access or unrestricted shell/network.
- Personal `~/.codex/auth.json` mounted into a shared service.
- Raw student messages or provider tokens in command arguments or logs.
- Automatic fallback for a request that has already executed a side effect.
- Wildcard Discord guild/channel access.
- A single process holding ingress credentials, LLM credentials, Canvas write
  credentials, and database administrator credentials.
