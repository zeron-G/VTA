# Repository Instructions

- Keep VirtualTeachingAssistant centered on its Python 3.11+ framework and
  typed architecture. Linux and Node.js 22.19+ apply to the documented legacy
  OpenClaw server deployment, not to the identity of the project.
- Treat the bundled `course-ta` skill as a versioned prompt and tool contract.
- Never add runtime profiles, credentials, logs, course material, student data,
  real Discord IDs, or institution-specific configuration.
- Use placeholders under `example.com` and documented fake IDs in tests.
- Run unit tests, `compileall`, package build, skill validation, and
  documentation/architecture checks plus `scripts/security_scan.py` before
  publishing.
- Keep Canvas health checks read-only and never send a Discord message from a
  health check.
