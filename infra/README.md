# Local Infrastructure

Local development services for the Virtual Teaching Assistant (VTA), defined in
the repo-root [`docker-compose.yml`](../docker-compose.yml):

| Service    | Image                     | Host port | Purpose                                   |
| ---------- | ------------------------- | --------- | ----------------------------------------- |
| `postgres` | `pgvector/pgvector:pg16`  | `5432`    | PostgreSQL 16 + pgvector (RAG embeddings) |
| `redis`    | `redis:7-alpine`          | `6379`    | Redis 7 (BullMQ job queues)               |

Both services persist data in named Docker volumes (`vta-pgdata`,
`vta-redisdata`), so your data survives `docker compose down`.

## Prerequisites

- Docker Desktop (or a compatible Docker Engine) with Docker Compose v2
  (the `docker compose` subcommand, not the legacy `docker-compose` binary).
- A `.env` file at the repo root: `cp .env.example .env`. The defaults already
  match the Compose service credentials (`vta` / `vta` / `vta`).

## Start / stop

From the **repository root**:

```bash
# Start both services in the background.
pnpm infra:up
# (equivalent to:)
docker compose up -d

# Check status and health.
docker compose ps

# Tail logs.
docker compose logs -f postgres
docker compose logs -f redis

# Stop services (data is preserved in the named volumes).
pnpm infra:down
# (equivalent to:)
docker compose down

# Stop services AND delete the volumes (full reset — destroys all local data).
docker compose down -v
```

> **Note:** `pnpm infra:up` / `pnpm infra:down` are convenience scripts wired in
> the root `package.json`. If they are not present yet, use the `docker compose`
> commands directly.

## Connecting

### PostgreSQL

Connection string (also set as `DATABASE_URL` in `.env`):

```
postgres://vta:vta@localhost:5432/vta
```

Connect with `psql` (uses the bundled client inside the container, so no local
install is required):

```bash
docker exec -it vta-postgres psql -U vta -d vta
```

Or, if you have a local `psql`:

```bash
psql "postgres://vta:vta@localhost:5432/vta"
```

### Redis

Connection string (also set as `REDIS_URL` in `.env`):

```
redis://localhost:6379
```

Quick connectivity check:

```bash
docker exec -it vta-redis redis-cli ping
# -> PONG
```

## Confirming pgvector is enabled

The extension is created automatically on first cluster init by
[`infra/postgres/init.sql`](./postgres/init.sql). Verify it:

```bash
docker exec -it vta-postgres psql -U vta -d vta -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';"
```

Expected output (version may vary):

```
 extname | extversion
---------+------------
 vector  | 0.8.0
(1 row)
```

If the `vector` row is missing, the init script likely did not run because the
data volume already existed before the script was mounted. Recreate the volume:

```bash
docker compose down -v && docker compose up -d
```

(Alternatively, enable it manually for the current database:
`docker exec -it vta-postgres psql -U vta -d vta -c "CREATE EXTENSION IF NOT EXISTS vector;"`)

## Applying retrieval indexes

`drizzle-kit` (`pnpm db:push`) creates the tables but does **not** manage the
pgvector extension or the retrieval indexes that the RAG queries depend on: the
HNSW (cosine) ANN index on `chunks.embedding`, the GIN full-text index on
`to_tsvector('english', content)`, and the btree index on the denormalized
tenant key `chunks.course_id`.

Run the idempotent index script **once after `pnpm db:push`** (from the
repository root):

```bash
pnpm db:push      # create/update tables (drizzle-kit)
pnpm db:indexes   # create the pgvector + full-text + tenant indexes
```

`pnpm db:indexes` uses `DATABASE_URL` and is safe to re-run — every statement is
`IF NOT EXISTS`. Re-run it after any full reset (`docker compose down -v`) that
drops the tables.

## Troubleshooting

### Init script did not run

`init.sql` only executes on the **first** initialization of an empty data
directory. If you started Postgres before the script was mounted (or with a
different config), the `vta-pgdata` volume is already populated and the script
is skipped. Fix with a full reset: `docker compose down -v && docker compose up -d`.

### Port already in use

If `5432` or `6379` is taken (e.g. a locally installed Postgres/Redis), either
stop the conflicting service or remap the host port in `docker-compose.yml`
(for example `"5433:5432"`) and update `DATABASE_URL` / `REDIS_URL` in `.env`
to match.

### Health checks failing

Inspect health and recent logs:

```bash
docker compose ps
docker inspect --format '{{json .State.Health}}' vta-postgres
docker compose logs postgres
```

A healthy Postgres reports `pg_isready` success; a healthy Redis answers
`redis-cli ping` with `PONG`.

### WSL2 / Docker Desktop integration (Windows)

When running the project from a WSL2 distro on Windows:

1. Open **Docker Desktop → Settings → Resources → WSL Integration** and enable
   integration for the distro you develop in. Without this, `docker` /
   `docker compose` are not available on your WSL `PATH`.
2. Use `localhost` for connection strings. Docker Desktop forwards published
   ports to the Windows host *and* to the integrated WSL distro, so
   `localhost:5432` / `localhost:6379` work from inside WSL.
3. If `docker` is not found in WSL after enabling integration, fully restart
   Docker Desktop (and, if needed, run `wsl --shutdown` from a Windows
   terminal, then reopen the distro).
4. For best filesystem performance, keep the repository inside the WSL
   filesystem (e.g. `~/code/...`) rather than under `/mnt/c/...`.
