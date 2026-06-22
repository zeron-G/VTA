# Legacy Linux Server Deployment

This page applies to the current shell/OpenClaw compatibility deployment. The
V2 Python framework itself is not Linux-specific. See the platform-wide
[deployment overview](deployment/overview.md).

## Deployment gate

The repository does not yet contain an institution-approved production stack.
Do not treat `VTA_STAGE=production` as proof that deployment controls exist. Production
requires closure of the issues under `issues/`, security review, and validation
in a non-production Carey Canvas/Discord environment.

## Required isolation

Use separate non-root service identities for the control plane, Codex worker,
OpenClaw worker, and side-effect executor. Apply:

- read-only root filesystems where practical;
- private temporary directories and no shared home directory;
- explicit outbound DNS/HTTPS allowlists;
- no access to SSH keys, cloud metadata, Docker sockets, or operator homes;
- external managed secrets injected as files or service credentials;
- encrypted durable state with backup/restore tests;
- resource, process, request-size, and request-time limits.

Codex and OpenClaw must be isolated before setting `VTA_CODEX_ISOLATED=true` or
`VTA_OPENCLAW_ISOLATED=true`. Those flags are operator assertions, not a
sandbox implementation.

## Legacy compatibility deployment

The existing scripts deploy the original OpenClaw Course TA profile. They are
useful for migration and sandbox evaluation but are not the V2 production
control plane.

```bash
install -m 600 .env.example /srv/virtual-ta/vta.env
export COURSE_TA_ENV_FILE=/srv/virtual-ta/vta.env
./deploy.sh --dry-run
./deploy.sh --yes
./check.sh
```

The service account needs access only to its installation, private environment,
course-material source, OpenClaw state, and a user-owned npm prefix. Never run
the gateway as root and never place secrets in a systemd command line.

## Platform checks

```bash
virtual-ta config-check
virtual-ta self-check
course-ta-deploy --env-file /srv/virtual-ta/vta.env check --offline
course-ta-deploy --env-file /srv/virtual-ta/vta.env check
```

The legacy online check performs read-only model, Canvas course, Discord route,
gateway, and memory-index probes. Probe output must remain redacted. A healthy
probe proves connectivity, not authorization for production use.

## Promotion sequence

1. Build a signed artifact in CI and generate a software bill of materials.
2. Deploy to an isolated development tenant with synthetic course data.
3. Run unit, safety, integration, restoration, load, and failure-injection tests.
4. Complete institutional privacy, security, accessibility, and records review.
5. Pilot one allowlisted course with human approval on every side effect.
6. Review audit evidence and rollback behavior before expanding scope.

Support bundles may include only versions and redacted health summaries. Never
include environment files, prompts, Canvas caches, student data, OAuth state,
OpenClaw state, logs, or backups.
