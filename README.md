# VirtualTeachingAssistant

VirtualTeachingAssistant is a Linux-first, security-oriented teaching-agent
platform intended for evaluation at the Johns Hopkins Carey Business School.
It supports course Q&A today and defines extension contracts for live-class
analysis, post-class recaps, classroom activities, and future communication
channels.

This repository is an engineering foundation, not an institution-approved
production service. Real student data must not be used until identity, privacy,
accessibility, records-retention, security, and operational reviews are closed.

## Implemented foundation

- Immutable request, capability, data-classification, and response contracts.
- Role- and mode-based policy that removes every agent side effect.
- Ordered `native -> codex-cli -> openclaw` fallback with timeouts, circuit
  breakers, and permission-monotonic degradation.
- Official OpenAI Responses API transport with `store=false` and credential
  failover controls.
- Development-only adapter for `zeron-G/codex_oauth`; production configuration
  rejects personal OAuth fallback.
- Restricted Codex CLI adapter using stdin, an ephemeral session, read-only
  sandbox, ignored user configuration, and no `--yolo` mode.
- Separate approval/execution state machine. Grades, enrollment, assessment
  publication, and bulk messaging require two distinct approvers.
- Extensible channel, skill, activity, agent, LLM, audit, and health ports.
- Minimized HMAC audit events, bounded health probes, and redacted diagnostics.
- A platform-first `course-ta` skill that treats retrieved content as untrusted
  and emits proposals instead of directly writing Canvas or Discord.
- The original OpenClaw deployment/check CLI as a migration compatibility layer.

## Safety invariants

1. An agent may reason and draft, but it may never perform a side effect.
2. Fallback may preserve or reduce authority; it may never add authority.
3. Invalid, policy-denied, and content-safety failures do not trigger fallback.
4. Highly restricted records never enter an agent request.
5. Raw prompts, actor identifiers, tokens, and model output are absent from
   platform audit records.
6. Production rejects experimental personal OAuth and unisolated Codex/OpenClaw
   workers at configuration time.

See [architecture](docs/architecture/overview.md), [threat model](docs/architecture/threat-model.md),
and [architecture decisions](docs/adr/) for the full design.

## Local engineering setup

Requires Python 3.11 or newer.

```bash
git clone https://github.com/zeron-G/VirtualTeachingAssistant.git
cd VirtualTeachingAssistant
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e .
virtual-ta architecture
virtual-ta self-check
```

`virtual-ta self-check` is deliberately local and non-networked. The legacy
deployment doctor performs read-only Canvas, Discord, OpenClaw, and model
connectivity probes:

```bash
cp .env.example .env
chmod 600 .env
./deploy.sh --dry-run
./check.sh
```

Never use placeholder credentials outside a disposable test environment. Read
[Linux deployment](docs/linux-server.md) before operating the compatibility
layer.

## Authentication

Production should use a dedicated official OpenAI API key or an approved
enterprise service identity stored in an external secrets manager. Failover is
limited to authentication, rate-limit, timeout, availability, and internal
transport failures.

[`zeron-G/codex_oauth`](https://github.com/zeron-G/codex_oauth) accesses an
unsupported ChatGPT Codex backend with a local interactive sign-in cache. Its
own documentation limits it to local prototypes. VTA therefore marks this
transport `production_allowed = false` and rejects it in production.

## Repository layout

```text
virtual_teaching_assistant/         V2 domain, ports, orchestration, adapters
course_ta_deployer/                 Legacy OpenClaw deployment compatibility
course_ta_deployer/skills/course-ta Bundled teaching policy skill
docs/architecture/                  System design and threat model
docs/adr/                           Architecture decisions
docs/runbooks/                      Failure and operations guidance
specs/architecture-v2/              Scope, plan, tasks, and evidence
evals/                              Synthetic safety contract only
issues/                             Explicit production-readiness backlog
tests/                              Unit and architecture regression tests
```

## Verification

```bash
python -m unittest discover -s tests -v
python -m compileall -q virtual_teaching_assistant course_ta_deployer tests scripts
python scripts/check_architecture.py
python scripts/validate_evals.py
python scripts/security_scan.py .
python -m build
```

No production logs, course materials, student records, OAuth tokens, Canvas
tokens, Discord tokens, or OpenClaw runtime profiles belong in this repository.
See [Security](SECURITY.md) and [Third-party software](THIRD_PARTY.md).

## License

[MIT](LICENSE). Third-party components retain their own licenses.
