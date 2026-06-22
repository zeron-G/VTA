# Getting Started

## Prerequisites

- Python 3.11 or newer.
- Git.
- Optional: Codex CLI for local adapter experiments.
- Optional: Node.js 22.19+ and npm only for the legacy OpenClaw deployer.

The V2 Python library is not tied to Linux. The compatibility shell scripts and
documented server installation currently target Linux.

## Create a development environment

```bash
git clone https://github.com/zeron-G/VirtualTeachingAssistant.git
cd VirtualTeachingAssistant
python -m venv .venv
```

Activate it:

```bash
# Linux/macOS
. .venv/bin/activate

# Windows PowerShell
.venv\Scripts\Activate.ps1
```

Install an editable copy plus build tooling:

```bash
python -m pip install --upgrade pip
python -m pip install -e . build
```

## Confirm the platform package

```bash
virtual-ta version
virtual-ta architecture
virtual-ta self-check
```

- `version` prints the package version.
- `architecture` prints stable safety posture and configured backend order.
- `self-check` is local-only: Python version, bundled skill discovery, and
  enabled executable presence. It makes no provider requests.

The default development configuration enables the native tier in configuration,
but no native engine is composed by the CLI. The diagnostic command is not a
student-facing server.

## Run the development gates

```bash
python -m unittest discover -s tests -v
python -m compileall -q virtual_teaching_assistant course_ta_deployer tests scripts
python scripts/check_architecture.py
python scripts/check_docs.py
python scripts/validate_evals.py
python scripts/security_scan.py .
python -m build
```

See [Testing](testing.md) for what each gate proves and does not prove.

## Explore the source in order

1. `domain/models.py`: platform vocabulary and structural limits.
2. `orchestration/policy.py`: authorization-independent capability policy.
3. `orchestration/fallback.py`: backend selection and failure behavior.
4. `orchestration/service.py`: minimized auditing around the use case.
5. `orchestration/actions.py`: separate side-effect approval lifecycle.
6. `ports/`: extension contracts.
7. `infrastructure/`: concrete or partial adapters.

Read [Current state](../architecture/current-state.md) alongside the code so a
contract-only adapter is not mistaken for a running integration.

## Configuration during development

`PlatformConfig.from_env()` reads `VTA_*` variables directly from the process.
It does not automatically load `.env`. The legacy CLI separately reads an
explicit environment file containing `COURSE_TA_*` values.

Do not put real secrets in the repository. Use synthetic values for unit tests
and an external developer secret mechanism for approved integration testing.
See [Configuration](../reference/configuration.md).

## Working on a change

Non-trivial work follows the repository's controlled workflow:

1. Read `AGENTS.md` and relevant architecture decisions.
2. Create or select a scoped issue/spec.
3. Define goals, non-goals, safety invariants, and verification.
4. Add a focused test or reproduction.
5. Implement behind the existing port/module boundary.
6. Run focused tests, then all relevant repository gates.
7. Publish a reviewable PR with evidence and remaining risk.

Do not use real student data as a development fixture. Do not weaken policy,
redaction, sandbox flags, or security scans to make a test pass.

## Legacy compatibility environment

To inspect deployment without writing system state:

```bash
cp .env.example .env
# Replace placeholders with synthetic sandbox values.
chmod 600 .env
./deploy.sh --dry-run
./check.sh --offline
```

The deployer can perform real network operations and install OpenClaw when run
without `--dry-run`; read [Deployment](../deployment/overview.md) first.
