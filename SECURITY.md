# Security Policy

## Never commit runtime data

Do not commit or upload:

- `.env` or any completed environment file.
- Canvas, Discord, OpenAI, Codex OAuth, or gateway credentials.
- `openclaw.json`, `auth-profiles.json`, cookies, or session state.
- Course materials, Canvas sync caches, rosters, grades, student identifiers,
  Discord exports, interaction logs, or deployment backups.

The repository ignores common runtime locations, and CI runs
`scripts/security_scan.py`. These controls are guardrails, not permission to
store sensitive data in the working tree.

## Credential handling

Use the least-privileged Canvas token possible. Restrict the Discord bot to the
configured guild and explicit channels. Keep environment and profile files
owner-readable only. OpenClaw must manage its own OAuth refresh tokens; VTA does
not copy or export them.

If a credential is exposed, revoke and rotate it immediately, remove it from
Git history, and review provider audit logs. Deleting the latest file is not
sufficient after a push.

## Reporting

Do not open a public issue containing a vulnerability exploit, credential,
student record, or production log. Use GitHub's private vulnerability reporting
for the repository when available.

Include only redacted health-check output, VTA/OpenClaw versions, operating
system details, and minimal reproduction steps.
