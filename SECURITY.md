# Security Policy

## Production status

VirtualTeachingAssistant is not approved for real Carey student data. A pilot
requires institutional identity/RBAC, managed secrets, durable encrypted state,
data-retention rules, privacy and accessibility review, incident response, and
an approved evaluation corpus. The tracked gaps are in [`issues/`](issues/).

## Never commit runtime data

Do not commit or upload environment files, credentials, OAuth/session state,
course materials, Canvas caches, rosters, grades, accommodations, student
identifiers, Discord exports, model transcripts, audit logs, or backups.

The repository ignores common runtime locations and CI runs
`scripts/security_scan.py`. Those are guardrails, not authorization to place
sensitive data in the working tree.

## Credential and worker rules

- Use a dedicated, least-privileged service identity and external secret store.
- Do not copy personal Codex OAuth state to a shared server.
- Do not run Codex with `--yolo`, `danger-full-access`, or inherited user config.
- Run Codex and OpenClaw in separate non-root workers with network/filesystem
  allowlists before enabling either in production.
- Restrict Canvas scopes and Discord guild/channel allowlists per course.
- Keep side-effect execution outside all agent workers and require approval.

If a credential is exposed, revoke and rotate it immediately, remove it from
Git history, and review provider audit logs. Deleting the latest file is not
sufficient after a push.

## Reporting

Use GitHub private vulnerability reporting. Do not open a public issue with an
exploit, credential, student record, prompt transcript, or production log.
Include only redacted diagnostics, versions, and a minimal synthetic
reproduction.
