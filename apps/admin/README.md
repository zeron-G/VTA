# @vta/admin

The operator CLI for the Virtual Teaching Assistant. A fresh database is empty,
so the system cannot answer anything until a course has been onboarded and its
Canvas materials ingested into retrievable chunks. This CLI is that operational
entrypoint: it onboards courses, maps their channels, assigns staff roles, and
runs Canvas ingestion.

It is a hand-rolled `argv` dispatcher with no command-parsing framework. The
database pool and secrets provider are built once at startup and shared across
every subcommand. Secrets (Canvas tokens, LLM keys) are never read or printed
here — they are resolved inside the services via the `SecretsProvider`.

## Running

```bash
# From the repo root, after `pnpm install` and building the workspace:
pnpm --filter @vta/admin dev -- <command> [--flags]      # tsx, no build needed
# or, after `pnpm --filter @vta/admin build`:
pnpm --filter @vta/admin start -- <command> [--flags]    # node dist/main.js
```

The `--` separates pnpm's own flags from the CLI's flags.

## Commands

| Command | Flags | Purpose |
| --- | --- | --- |
| `course:add` | `--slug <s> --name <n> --canvas-id <id> [--org <uuid>]` | Register/refresh a course and seed default governance config + empty channel map. |
| `course:map-channel` | `--slug <s> --channel <discordChannelId> [--guild <id>]` | Add a Discord channel id to the course's `channelMap.discord`. |
| `course:set-role` | `--slug <s> --discord-id <id> --role <admin\|privileged\|standard> [--name <displayName>]` | Resolve/create the user by Discord id and set their per-course role. |
| `course:ingest` | `--slug <s>` | Sync the course's Canvas content into embedded, retrievable chunks. Prints `IngestStats`. |
| `course:list` | — | List all registered courses (slug, name, canvasCourseId). |

Course roles: `admin` = professor/owner, `privileged` = TA, `standard` =
enrolled student (the default for anyone with no membership row).

## Required environment

Loaded from a local `.env` (via `dotenv`) when present; in production the
process environment is already populated.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres (pgvector) connection string. |
| `LLM_PROFILE` | no (default `dev`) | `dev` \| `prod`. Selects the embedding model used during ingest. |
| `SECRETS_PROVIDER` | no (default `env`) | `env` \| `keyvault`. |
| `AZURE_KEY_VAULT_URL` | only if `keyvault` | Vault URL when `SECRETS_PROVIDER=keyvault`. |
| `CANVAS_TOKEN_<SLUG>` | for `course:ingest` | Per-course Canvas API token. Slug is upper-cased with `-`/`.` → `_`. |
| `CANVAS_BASEURL_<SLUG>` | no | Optional per-course Canvas base URL override. |
| `OPENAI_API_KEY` | for `course:ingest` | Resolved as `openai.api-key` for embeddings. |

Secret-name mangling follows the `@vta/shared` env provider convention:
`canvas.token.ai-essentials` reads `CANVAS_TOKEN_AI_ESSENTIALS`.

## End-to-end: onboarding the AI Essentials pilot

A complete onboarding for the pilot course, end to end. Replace the Canvas
course id, Discord ids, and token with the real values.

```bash
# 0. .env (local development)
cat > .env <<'EOF'
DATABASE_URL=postgres://vta:vta@localhost:5432/vta
LLM_PROFILE=dev
SECRETS_PROVIDER=env
# Per-course Canvas token: slug "ai-essentials" -> CANVAS_TOKEN_AI_ESSENTIALS
CANVAS_TOKEN_AI_ESSENTIALS=canvas_pat_xxx
# Optional per-course Canvas base URL: slug -> CANVAS_BASEURL_AI_ESSENTIALS
CANVAS_BASEURL_AI_ESSENTIALS=https://jhu.instructure.com
# Embeddings key (resolved as openai.api-key)
OPENAI_API_KEY=sk-xxx
EOF

# 1. Register the course (Canvas course id 220123 is an example).
pnpm --filter @vta/admin dev -- course:add \
  --slug ai-essentials \
  --name "AI Essentials" \
  --canvas-id 220123

# 2. Route the course's Discord channel to it.
pnpm --filter @vta/admin dev -- course:map-channel \
  --slug ai-essentials \
  --channel 112233445566778899 \
  --guild 998877665544332211

# 3. Make Gordon Gao the course admin (professor).
pnpm --filter @vta/admin dev -- course:set-role \
  --slug ai-essentials \
  --discord-id 123456789012345678 \
  --role admin \
  --name "Gordon Gao"

# 4. Ingest the course's Canvas material into retrievable chunks.
pnpm --filter @vta/admin dev -- course:ingest --slug ai-essentials

# 5. Verify it landed.
pnpm --filter @vta/admin dev -- course:list
```

After step 4 the database holds embedded chunks for the course, so the
answering path (`@vta/core` `TeachingService`, driven by the Discord worker)
can ground replies in real material.

## Exit codes

- `0` — success (and explicit `help`).
- `2` — usage error: unknown command, missing/invalid flag, or a bare
  invocation with no command.
- `1` — runtime error (e.g. course not found, missing Canvas token, DB error).
  Only the error message is printed, never secrets or the full error object.
