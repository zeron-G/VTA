# P1: Enforce Linux isolation for every agent backend

Category: Security / Runtime

Impact: A compromised model or prompt injection could access host data or
credentials if workers share the ingress process or service account.

Acceptance criteria: Dedicated worker identities/containers, read-only roots,
resource limits, egress allowlists, minimal secret mounts, and kill switches.

Verification: Sandbox escape, filesystem, network, process, timeout, and secret
visibility tests for native, Codex, and OpenClaw workers.
