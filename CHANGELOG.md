# Changelog

This project records material architecture, security, behavior, interface, and
packaging changes here. Versioning policy is still being established; until
then, treat changes to V2 enums, dataclasses, protocols, manifests, policy, and
fallback behavior as compatibility-relevant.

## Unreleased

### Documentation

- Reframed the project as a policy-governed Python teaching-agent framework;
  Linux is documented as a legacy/server deployment target, not project identity.
- Added an accurate current-state inventory, component/request architecture,
  development, extension, configuration, deployment, operations, roadmap,
  glossary, contributing guide, and documentation validation gate.
- Added an accessible repository-owned animated architecture visual.

## 2.0.0

### Added

- V2 immutable domain and Python port contracts.
- Role/mode/data policy, circuit breakers, permission-monotonic agent fallback,
  and minimized teaching-service audit.
- Restricted Codex CLI adapter, native/OpenClaw boundaries, official OpenAI
  transport, credential failover, and production rejection of experimental
  personal OAuth.
- Side-effect proposal/approval coordinator with two-person rules for high-risk
  action types.
- Skill, channel, activity, health, audit, configuration, architecture, threat,
  ADR, eval, security, and CI foundations.

### Compatibility

- Retained the original `course_ta_deployer` and bundled Course TA skill as a
  migration/sandbox path.

## 1.0.0

- Published the initial OpenClaw Course TA deployment package with Canvas sync,
  Discord allowlists, bundled skill installation, and connectivity checks.
