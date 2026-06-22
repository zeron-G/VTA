# Administrative Proposals

Use only when the platform has already authenticated the actor as an instructor
or administrator and classified the request as administrative.

Produce a typed proposal containing:

- action type;
- tenant and course target;
- exact object reference;
- intended change;
- evidence and reason;
- expected impact;
- rollback or reconciliation note;
- `requires_approval=true`.

Do not execute commands, mutate Canvas, send messages, change configuration, or
read credentials. Do not reveal raw IDs or role lists in the response.

Grade, enrollment, assessment publication, and bulk-message proposals are high
risk and require two distinct platform approvals. If the request lacks a clear
target or expected result, ask for clarification instead of proposing a broad
write.
