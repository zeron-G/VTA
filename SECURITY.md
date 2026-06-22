# Security Policy

## Maturity and supported code

VirtualTeachingAssistant version `2.0.0` is an architecture foundation, not an
institution-approved production student service. Security fixes target the
latest `main` branch until a formal release/support policy is adopted. The
legacy OpenClaw compatibility package remains supported for controlled migration
and sandbox evaluation, not as evidence that the V2 controls are fully wired.

Real Carey/JHU student data requires institutional identity/RBAC, managed
secrets, durable encrypted state, retention/deletion rules, privacy and
accessibility review, incident response, approved vendors/providers, isolated
workers, and an approved evaluation program. See [Current state](docs/architecture/current-state.md),
[Threat model](docs/architecture/threat-model.md), and the tracked
[production-readiness backlog](issues/).

## Report a vulnerability

Use the repository's GitHub private vulnerability reporting. Do not open a
public issue, discussion, or pull request containing an exploit, credential,
student record, prompt transcript, provider response, or production log.

Include only what is necessary:

- affected commit/version and component;
- synthetic reproduction and expected/actual behavior;
- impact and prerequisites;
- redacted diagnostic references;
- suggested mitigation when known.

Do not test against real courses, students, provider accounts, or institutional
systems without explicit authorization. Receipt and remediation timing depend on
maintainer availability until an institutional response process exists.

## Never commit runtime data

Do not commit or upload:

- completed environment files, API keys, OAuth/session state, cookies, private
  keys, OpenClaw profiles, or secret-manager output;
- Canvas materials/caches, rosters, grades, submissions, accommodations,
  attendance, student identifiers, or instructor-only assessments;
- Discord exports, model prompts/responses, audit events, logs, backups, or
  support bundles containing runtime state;
- local absolute paths, usernames, private network details, or provider request
  bodies that reveal sensitive context.

The `.gitignore`, test fixtures, and `scripts/security_scan.py` are guardrails,
not authorization to place sensitive information in the working tree or Git
history.

## Credential and identity rules

- Use dedicated, least-privileged service identities with documented owners,
  scopes, rotation, revocation, and offboarding.
- Do not copy or mount personal `~/.codex/auth.json` state into shared services.
- Treat `zeron-G/codex_oauth` as development-only; production config rejects it.
- Keep model, ingress, Canvas-write, audit, and database-admin credentials in
  separate identities and processes.
- Never pass secrets or prompt content in process arguments or safe error text.
- Restrict Canvas scopes and Discord guild/channel access per course.

If a credential is exposed: revoke/rotate it, disable affected service paths,
review provider/audit evidence, remove it from Git history, and document the
incident through an approved private process. Deleting the latest file or commit
is insufficient after a push.

## Agent and worker rules

- Do not run Codex with `--yolo`, `danger-full-access`, inherited user config, or
  a writable production/course repository.
- Run Codex and OpenClaw behind separate non-root OS/container/service boundaries
  with filesystem, egress, resource, process, and timeout limits.
- Treat course documents, links, transcripts, channel messages, model output,
  logs, and tool results as untrusted content.
- Apply policy before an agent and never expand authority during fallback.
- Keep side-effect execution outside agent workers; require typed validation,
  human approval, idempotency, audit, and reconciliation.
- Health checks are non-mutating and must not send test messages or Canvas writes.

`VTA_CODEX_ISOLATED=true` and `VTA_OPENCLAW_ISOLATED=true` are assertions checked
by configuration. They are not isolation mechanisms.

## Data and logging

Default agent access is public/internal course information. Restricted data needs
an approved use-case/provider policy. Highly restricted data never enters a
general agent prompt.

Operational audit stores only bounded references, HMAC actor/content digests,
counts, backend/tier/outcome, and safe failure categories. Raw prompts, answers,
identities, grades, and credentials are excluded. Production still needs
approved audit access, integrity, retention, deletion, and key rotation.

## Security verification

Every security-sensitive change needs focused tests/evals in addition to CI.
Relevant gates include policy allow/deny paths, permission-monotonic fallback,
transport production eligibility, process argument/environment inspection,
prompt/identity audit exclusion, skill safety cases, architecture boundaries,
documentation links, security scanning, and distribution inspection.

CI does not replace provider sandbox testing, dependency/SBOM review,
penetration testing, isolation verification, backup recovery, load/failure
testing, or institutional security review.
