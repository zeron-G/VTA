# Virtual Teaching Assistant (VTA)

VTA is a Linux-first deployment package for a Discord course teaching
assistant powered by [OpenClaw](https://github.com/openclaw/openclaw). It
bundles the reusable `course-ta` skill and configures Canvas, Discord, model
authentication, course-material indexing, and the OpenClaw gateway.

The repository contains source code and placeholder configuration only. It does
not contain production logs, course materials, student data, OAuth tokens,
Canvas tokens, Discord tokens, or an OpenClaw runtime profile.

## What is included

- A Python CLI for repeatable, isolated OpenClaw profile deployment.
- The sanitized and reusable `course-ta` skill as wheel package data.
- Automatic installation of the official OpenClaw npm package.
- Codex OAuth, OpenAI API-key, or existing-profile authentication modes.
- Canvas initial sync and local RAG indexing.
- Discord guild/channel allowlists with mention gating.
- Read-only `check` probes for dependencies, OAuth/model access, Canvas course
  access, Discord routing, gateway status, and memory indexing.

OpenClaw itself is not copied into this repository. VTA installs the official
`openclaw@2026.6.8` package from npm, whose published metadata points to the
official OpenClaw GitHub repository. See [Third-party software](THIRD_PARTY.md).

## Linux requirements

- A current Linux distribution with `bash`.
- Python 3.10 or newer with the `venv` module.
- Node.js 22.19 or newer and npm.
- A Discord bot token and server/channel IDs.
- A Canvas HTTPS base URL, course ID, and access token with the least privileges
  required for the course.
- Codex OAuth access or an OpenAI API key.

Use a non-root service account. Ensure its npm global prefix is writable before
deployment; VTA never runs `curl | sh` or elevates itself with `sudo`.

## Quick deployment

```bash
git clone https://github.com/zeron-G/VTA.git
cd VTA
chmod +x deploy.sh check.sh
./deploy.sh
```

The first run creates an owner-only `.env` from `.env.example` and stops. Edit
every `REPLACE_ME` value, then deploy:

```bash
chmod 600 .env
./deploy.sh --yes
```

The script creates `.venv`, installs VTA and its Python dependencies, installs
the pinned OpenClaw npm package when missing, installs the bundled skill into an
isolated profile, performs the initial Canvas sync, indexes memory, and installs
the gateway when enabled.

Run the full read-only health check:

```bash
./check.sh
```

Run only local checks:

```bash
./check.sh --offline
```

## CLI

```bash
course-ta-deploy --env-file /secure/path/vta.env plan
course-ta-deploy --env-file /secure/path/vta.env deploy --yes
course-ta-deploy --env-file /secure/path/vta.env check
course-ta-deploy --env-file /secure/path/vta.env check --offline
course-ta-deploy print-env
```

`check` emits JSON with `ok`, `failed`, and `skipped` states. Canvas and Discord
connectivity checks use only HTTP GET requests. The model probe is a real
OpenClaw provider request limited to one output token.

## Authentication modes

- `codex-oauth`: starts OpenClaw's official `openai-codex` login and lets
  OpenClaw own refresh-token storage.
- `openai-api-key`: reads `OPENAI_API_KEY` and stores it only in the target
  profile's owner-only environment file.
- `existing`: uses authentication already present in the isolated profile.

VTA never copies Codex OAuth files, browser cookies, or tokens from another
profile.

## Repository layout

```text
course_ta_deployer/                 Python deployment CLI
course_ta_deployer/skills/course-ta Bundled OpenClaw skill
docs/                               Linux and external-link documentation
scripts/security_scan.py            Pre-publish secret/privacy scanner
tests/                              Unit tests with fake credentials only
```

Generated `config/`, `data/`, logs, course caches, Discord exports, and
credentials are runtime artifacts and are intentionally absent and gitignored.

## Validation

```bash
python3 -m unittest discover -s tests -v
python3 -m compileall -q course_ta_deployer tests scripts
python3 scripts/security_scan.py .
python3 -m build
```

## Security

Read [SECURITY.md](SECURITY.md) before operating VTA with real student or
credential data. Never attach `.env`, an OpenClaw state directory, Canvas sync
cache, or logs to a public issue.

## License

VTA is licensed under the [MIT License](LICENSE). Third-party packages retain
their own licenses.
