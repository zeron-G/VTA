# Repository Instructions

- Keep VTA Linux-first and compatible with Python 3.10+ and Node.js 22.19+.
- Treat the bundled `course-ta` skill as a versioned prompt and tool contract.
- Never add runtime profiles, credentials, logs, course material, student data,
  real Discord IDs, or institution-specific configuration.
- Use placeholders under `example.com` and documented fake IDs in tests.
- Run unit tests, `compileall`, package build, skill validation, and
  `scripts/security_scan.py` before publishing.
- Keep Canvas health checks read-only and never send a Discord message from a
  health check.
