# Architecture V2 Verification

- [x] Existing deployment unit tests remain green.
- [x] New core tests cover success, timeout, retryable failure, fatal failure,
  circuit open/half-open/recovery, permission monotonicity, and no-backend cases.
- [x] Auth tests cover API primary, experimental fallback, production rejection,
  and non-retryable errors.
- [x] Subprocess tests inspect argument and environment construction without making
  live model calls.
- [x] Audit tests prove raw prompts, actor ids, and secret-shaped values are absent.
- [x] Registry tests prove a future channel/activity can be added without changing
  orchestration.
- [x] Security scan, compileall, package build, and skill validation pass.
- [ ] GitHub Actions passes on Linux after repository rename.
