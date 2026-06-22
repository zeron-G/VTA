# Testing and Quality Gates

No single gate establishes production readiness. The repository combines tests,
static boundaries, fixture validation, security scanning, and package building.

## Unit tests

```bash
python -m unittest discover -s tests -v
```

| Area | Test modules | Primary evidence |
|---|---|---|
| Legacy configuration/deployment | `test_config`, `test_builders`, `test_deployment`, `test_doctor`, `test_runner` | Placeholder rejection, redaction, dry-run/no-write behavior, allowlists, read-only probes |
| Domain and policy | `test_platform_domain` | Immutability, structural validation, role/mode policy, restricted data denial |
| Agent fallback | `test_platform_fallback` | Order, retryable/fatal behavior, timeout, circuit recovery, permission monotonicity |
| Credentials/transports | `test_platform_auth`, `test_platform_adapters` | Production OAuth rejection, failover taxonomy, restricted subprocess arguments/environment, `store=False` |
| Approvals | `test_platform_actions` | Student denial, two distinct approvers, idempotent execution |
| Registries | `test_platform_registries` | Skill/channel/activity extension contracts |
| Audit/health/service | `test_platform_observability`, `test_platform_service` | Probe timeout, secret redaction, no raw prompt or actor in audit |

Tests use fake providers and credentials. They do not contact live services.

## Architecture boundary

```bash
python scripts/check_architecture.py
```

The script parses Python imports and prevents domain, ports, and orchestration
from depending on infrastructure, the legacy deployer, or selected network
libraries. It is a deliberately small boundary check, not a general linter.

## Documentation links

```bash
python scripts/check_docs.py
```

This validates repository-relative links and image sources in Markdown. It does
not fetch external URLs or render Mermaid; external availability remains outside
CI to avoid flaky network-dependent builds.

## Evaluation fixture contract

```bash
python scripts/validate_evals.py
```

The committed `evals/safety-cases.json` must cover prompt injection, tenant
isolation, authorization, academic integrity, secret protection, fallback
safety, and data classification. This gate validates schema/coverage only. A
future model eval runner needs approved datasets, scoring rubrics, thresholds,
cost/latency measurement, and release comparison.

## Security scan

```bash
python scripts/security_scan.py .
```

The scanner detects common secret formats, private keys, credential files,
runtime paths, identifying email patterns, and suspicious public artifacts. It
reduces accidental disclosure risk but does not replace Git history review,
dependency scanning, SAST, or institutional DLP.

## Compilation and package build

```bash
python -m compileall -q virtual_teaching_assistant course_ta_deployer tests scripts
python -m build
```

Build output must include both Python packages and the complete bundled
`course-ta` skill. It must exclude `.env`, logs, course data, local state, and
research checkouts.

## Skill validation

The skill manifest is exercised by registry tests. Contributors with the Codex
skill-authoring validator can additionally run its `quick_validate.py` against
`course_ta_deployer/skills/course-ta/`.

Every prompt/skill change must include an eval or test adjustment appropriate to
the behavior changed; prose review alone is insufficient.

## GitHub Actions

`.github/workflows/ci.yml` installs the package on Python 3.11 under Ubuntu and
runs unit tests, compilation, architecture checks, documentation link checks,
eval validation, the security scan, and distribution build.

CI proves the checked commit passes those gates on that runner. It does not prove
live Canvas/Discord compatibility, Windows/macOS behavior, worker isolation,
load characteristics, backup recovery, or educational quality.

## Validation by change type

| Change | Minimum additional evidence |
|---|---|
| Domain/policy | Unit tests for allow and deny paths; architecture check |
| Backend/fallback | Timeout, retry, fatal, circuit, and permission tests |
| Transport/auth | Production eligibility, secret handling, error mapping, live sandbox test outside public CI |
| Prompt/skill | Skill validation plus safety/task eval changes |
| Channel/provider | Signature/replay tests, payload fixtures, delivery idempotency, provider sandbox test |
| Action executor | Authorization, validation, idempotency, crash recovery, reconciliation, audit |
| Storage | Migration, concurrency, rollback, backup/restore test |
| Documentation | Link check, claim audit, SVG/Mermaid review |

## Release evidence

A release record should include commit, package version, CI URL, commands run,
test/eval summary, known gaps, rollback instructions, and dependency changes.
Never attach raw prompts, secrets, student data, or production logs.
