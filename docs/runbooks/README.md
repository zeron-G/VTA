# Runbooks

Runbooks describe bounded operator actions that do not depend on an agent being
available. Each production runbook should name triggers, owner, prerequisites,
safe evidence, commands/actions, validation, rollback, escalation, and incident
record requirements.

## Available

- [Degraded mode](degraded-mode.md): backend/transport failure, circuit state,
  permission-preserving fallback, and fail-closed behavior.

## Required before a pilot

- credential exposure and rotation;
- channel disablement and instructor kill switch;
- provider outage and message backlog;
- cross-course isolation incident;
- unexpected/duplicate side effect and reconciliation;
- audit pipeline failure;
- deployment rollback;
- database backup and restoration;
- course/term onboarding and offboarding.

Never paste raw prompts, student records, credentials, or provider bodies into a
public runbook or incident ticket.
