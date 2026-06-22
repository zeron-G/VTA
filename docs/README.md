# VirtualTeachingAssistant Documentation

This documentation describes both the code that exists today and the system the
project is designed to become. Status words have fixed meanings:

| Label | Meaning |
|---|---|
| Implemented | Executable V2 code and automated tests exist in this repository |
| Compatibility | The behavior exists in the original `course_ta_deployer`, not in the V2 composition root |
| Contract only | A typed model, protocol, registry, or wrapper exists without a production implementation |
| Planned | Target architecture only; no stable implementation contract exists |
| Institutional gate | Requires a Carey/JHU decision, approval, identity system, or managed infrastructure |

## Reading paths

### Educators and product reviewers

1. [Project README](../README.md)
2. [Current state](architecture/current-state.md)
3. [Request lifecycle](architecture/request-lifecycle.md)
4. [Roadmap](roadmap.md)
5. [Glossary](glossary.md)

### Python engineers

1. [Getting started](development/getting-started.md)
2. [Component model](architecture/components.md)
3. [Contracts reference](reference/contracts.md)
4. [Extending VTA](development/extending.md)
5. [Testing and quality gates](development/testing.md)

### Security, privacy, and architecture reviewers

1. [Architecture overview](architecture/overview.md)
2. [Threat model](architecture/threat-model.md)
3. [Architecture decisions](adr/)
4. [Configuration reference](reference/configuration.md)
5. [Production-readiness backlog](../issues/)

### Operators and deployment engineers

1. [Deployment overview](deployment/overview.md)
2. [Operations and observability](operations/observability.md)
3. [Degraded-mode runbook](runbooks/degraded-mode.md)
4. [Legacy Linux deployment](linux-server.md)

## Documentation map

| Document | Scope |
|---|---|
| [Current state](architecture/current-state.md) | Source-linked capability and gap inventory |
| [Architecture overview](architecture/overview.md) | Current foundation, target system, trust zones |
| [Component model](architecture/components.md) | Package ownership and dependency rules |
| [Request lifecycle](architecture/request-lifecycle.md) | Request, policy, fallback, audit, proposal flow |
| [Threat model](architecture/threat-model.md) | Assets, threats, controls, forbidden deployments |
| [Getting started](development/getting-started.md) | Local Python environment and first commands |
| [Testing](development/testing.md) | Unit, architecture, eval, security, build, and CI gates |
| [Extending VTA](development/extending.md) | Channel, agent, transport, skill, activity, and action extension rules |
| [Configuration](reference/configuration.md) | V2 and compatibility environment variables |
| [Contracts](reference/contracts.md) | Domain types, protocols, and error semantics |
| [Deployment](deployment/overview.md) | Deployment profiles and production gates |
| [Operations](operations/observability.md) | Audit, health, degradation, and missing telemetry |
| [Roadmap](roadmap.md) | Sequenced path to a controlled institutional pilot |
| [Glossary](glossary.md) | Stable vocabulary |
| [External links](external-links.md) | Authoritative upstream project and API links |
| [Contributing](../CONTRIBUTING.md) | Change workflow, validation, and PR expectations |
| [Changelog](../CHANGELOG.md) | Material architecture, behavior, security, and documentation changes |

## Sources of truth

- Runtime behavior: `virtual_teaching_assistant/` and `course_ta_deployer/`.
- Public package metadata: `pyproject.toml`.
- Security constraints: `SECURITY.md`, the threat model, and accepted ADRs.
- Current work acceptance: `specs/` and `issues/`.
- Automated evidence: `tests/`, `evals/`, and `.github/workflows/ci.yml`.

When documentation and code disagree, treat the code and tests as evidence,
then fix the documentation or file a scoped issue. Do not silently reinterpret a
security invariant.

## Documentation rules

- Never describe a target-state component as implemented.
- Never use real student prompts, credentials, course records, or logs as an
  example.
- Link claims to source modules, tests, ADRs, or issues when the distinction is
  not obvious.
- Keep diagrams understandable in adjacent prose and in monochrome rendering.
- Run `python scripts/check_docs.py` after changing Markdown or documentation
  assets.
