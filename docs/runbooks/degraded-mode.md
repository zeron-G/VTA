# Degraded Mode Runbook

## Trigger

Use when an agent backend, LLM credential, channel, Canvas, index, or database
health probe changes to degraded or failed.

## Automatic behavior

- Stop routing new requests to an open circuit.
- Continue only read-only Q&A on an eligible lower-tier backend.
- Mark responses as degraded in internal metadata, not in student-visible
  content unless service quality is affected.
- Queue no side effect after an ambiguous timeout.
- Preserve request and trace ids without raw message content.

## Operator actions

1. Check the health snapshot and failure category.
2. Disable the affected backend or credential explicitly if compromise is
   possible.
3. Rotate credentials for any suspected disclosure.
4. Use the instructor kill switch for live classroom features.
5. Re-enable through a canary probe, then a half-open circuit request.
6. Record incident timing, scope, remediation, and remaining risk.

## Never do

- Enable yolo/full-access agent mode to restore availability.
- Copy personal OAuth caches to the server.
- Post raw logs, prompts, student data, or tokens to a public issue.
- Repeat a Canvas/Discord write after a timeout without checking its
  idempotency record and provider state.
