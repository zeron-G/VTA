# ADR 0001: Begin as a modular monolith

Status: Accepted

## Decision

Implement the first platform control plane as a Python modular monolith with
hexagonal ports. Run agent backends in isolated subprocesses or services.

## Rationale

The current team and deployment target do not justify distributed operational
complexity. Clear domain and port boundaries provide migration points for
future services while keeping testing, deployment, and incident response
tractable for the pilot.

## Consequences

- Domain and orchestration modules cannot import vendor adapters.
- High-risk workers can be separated before the rest of the core.
- Persistent production state will later require Postgres/Redis adapters.
