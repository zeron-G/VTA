# P1: Add durable tenant state, idempotency, and transactional outbox

Category: Reliability / Data

Impact: In-memory pilot state cannot prevent duplicates or recover safely across
process restarts, especially for Discord delivery and Canvas writes.

Acceptance criteria: Postgres-backed tenant state and outbox, Redis or durable
idempotency, migrations, backups, restore tests, and write reconciliation.

Verification: Restart, duplicate-event, ambiguous-timeout, backup, and restore
integration tests.
