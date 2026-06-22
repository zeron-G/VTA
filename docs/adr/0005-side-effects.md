# ADR 0005: Separate reasoning from side effects

Status: Accepted

## Decision

Agents may emit typed action proposals. A separate executor validates tenant,
course, actor authorization, schema, idempotency, and approval before calling
Canvas, Discord, or future Carey application APIs.

Student requests cannot authorize writes. Instructor writes require explicit
confirmation; bulk messaging, grades, enrollment, and assessment publication
require stronger institutional policy and may require two-person approval.
