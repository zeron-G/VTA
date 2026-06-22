# Contributing

VirtualTeachingAssistant is an early architecture-stage project. Contributions
should strengthen a documented boundary or close a scoped gap; avoid broad
feature demonstrations that bypass policy, isolation, tests, or institutional
dependencies.

## Before starting

1. Read [`AGENTS.md`](AGENTS.md) and the [documentation index](docs/README.md).
2. Check [current state](docs/architecture/current-state.md), [roadmap](docs/roadmap.md),
   local [`issues/`](issues/), and GitHub issues.
3. For non-trivial work, create a spec under `specs/<feature>/` with goals,
   non-goals, invariants, plan, tasks, and verification.
4. Identify affected security, privacy, accessibility, data, provider, and
   compatibility boundaries before coding.

Do not use real student data, credentials, course exports, model transcripts,
or production logs in issues, tests, prompts, commits, or pull requests.

## Development

Follow [Getting started](docs/development/getting-started.md). Keep changes inside
the existing package boundary and prefer current protocols over new abstractions.

Every implementation change should include focused tests. Agent, skill, prompt,
transport, and tool changes also need appropriate eval coverage or a documented
reason the current eval runner cannot exercise them.

## Required verification

```bash
python -m unittest discover -s tests -v
python -m compileall -q virtual_teaching_assistant course_ta_deployer tests scripts
python scripts/check_architecture.py
python scripts/check_docs.py
python scripts/validate_evals.py
python scripts/security_scan.py .
python -m build
```

See [Testing](docs/development/testing.md) for additional evidence by change
type. Never weaken, skip, or delete a safety gate to land a change.

## Pull requests

Keep a pull request independently reviewable. Its description should explain:

- the problem and linked issue/spec;
- implementation and public contract changes;
- security/data/rollback impact;
- exact validation performed and results;
- known limitations and follow-up work.

CI is required but not sufficient for live integrations, storage migrations,
worker isolation, or teaching quality. Include sandbox/integration evidence when
the risk requires it, with all sensitive data removed.

## Architecture and security rules

- Domain and orchestration do not import infrastructure or provider SDKs.
- External content is untrusted, including retrieved course material.
- Backends receive only the capability envelope supplied by policy.
- Fallback never increases capability or data visibility.
- Agents cannot execute or approve external side effects.
- Personal OAuth is not a production service identity.
- Audit and diagnostics never become stores for raw prompts or student records.

Changes to these rules require an ADR, threat analysis, tests/evals, and explicit
human review.

## Documentation

Label capabilities accurately as implemented, compatibility, contract only,
planned, or institutional gate. Update current-state and reference docs with
code changes, and run `scripts/check_docs.py`.
