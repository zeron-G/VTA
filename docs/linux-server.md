# Linux Server Deployment

## Service account

Create or select an unprivileged account dedicated to VTA. Keep the repository,
virtual environment, `.env`, OpenClaw state, and workspace owned by that account.
Do not run the gateway as root.

Required permissions:

- Read the VTA installation and course-material source directory.
- Write the selected OpenClaw state and workspace directories.
- Install npm globals into a user-owned npm prefix.
- Reach the configured Canvas, Discord, npm, OpenAI, and OAuth endpoints.

## Environment file

Store the environment file outside a web root and apply mode `0600`:

```bash
install -m 600 .env.example /srv/vta/vta.env
```

Set `COURSE_TA_ENV_FILE=/srv/vta/vta.env` when invoking `deploy.sh` or
`check.sh`. Do not place secrets in a systemd unit body or command-line
arguments.

## Deployment sequence

```bash
export COURSE_TA_ENV_FILE=/srv/vta/vta.env
./deploy.sh --dry-run
./deploy.sh --yes
./check.sh
```

OpenClaw owns gateway service installation and restart behavior. Inspect the
generated profile and OpenClaw service status with the VTA check command rather
than copying runtime files into the repository.

## Updating

1. Back up the private environment file and OpenClaw state outside Git.
2. Pull a reviewed VTA release.
3. Review `.env.example` and `THIRD_PARTY.md` for version changes.
4. Run `./deploy.sh --dry-run`.
5. Run `./deploy.sh --yes` and then `./check.sh`.

The deployer writes configuration atomically and preserves timestamped backups
when replacing conflicting managed paths.

## Support bundles

Include only version numbers, redacted `check` JSON, and relevant static source
paths. Exclude `.env`, `openclaw.json`, `auth-profiles.json`, workspace memory,
Canvas caches, student data, logs, Discord count exports, and deployment
backups.
