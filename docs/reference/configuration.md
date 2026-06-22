# Configuration Reference

VirtualTeachingAssistant currently has two configuration domains:

- `VTA_*` configures the V2 Python platform policy/runtime foundation.
- `COURSE_TA_*` configures the legacy OpenClaw deployment compatibility path.

They are not automatically composed into one running service.

## V2 platform configuration

`PlatformConfig.from_env()` reads the current process environment. It does not
load `.env` by itself.

| Variable | Default | Meaning and validation |
|---|---|---|
| `VTA_STAGE` | `development` | `development`, `pilot`, or `production` |
| `VTA_TENANT_ID` | `carey` | Logical tenant reference, non-empty, at most 64 characters |
| `VTA_AGENT_ORDER` | `native,codex-cli,openclaw` | Unique comma-separated supported backend names |
| `VTA_AGENT_TIMEOUT_SECONDS` | `45` | Positive per-backend orchestration timeout |
| `VTA_CIRCUIT_FAILURE_THRESHOLD` | `3` | Positive failures before circuit opens |
| `VTA_CIRCUIT_RECOVERY_SECONDS` | `30` | Positive delay before one half-open trial |
| `VTA_ENABLE_NATIVE` | `true` | Enables configuration eligibility; does not create an engine |
| `VTA_ENABLE_CODEX_CLI` | `false` | Enables Codex CLI eligibility; executable must exist for self-check |
| `VTA_CODEX_ISOLATED` | `false` | Operator assertion required in production when Codex is enabled |
| `VTA_CODEX_WORKING_DIRECTORY` | `.` | Resolved worker directory; production must provide an isolated path |
| `VTA_ENABLE_OPENCLAW` | `false` | Enables OpenClaw eligibility; a safe V2 client is still required |
| `VTA_OPENCLAW_ISOLATED` | `false` | Operator assertion required in production when OpenClaw is enabled |
| `VTA_ALLOW_EXPERIMENTAL_OAUTH` | `false` | Allows development experimentation only; rejected in production |
| `VTA_AUDIT_HMAC_KEY` | development-only generated fallback | Production requires at least 32 characters from managed secret storage |
| `VTA_MODEL` | `gpt-5.5` | Non-empty model reference passed by future composition |

### Production validation

With `VTA_STAGE=production`, configuration fails closed when:

- the audit HMAC key is missing/short;
- experimental personal OAuth is enabled;
- Codex is enabled without `VTA_CODEX_ISOLATED=true`;
- OpenClaw is enabled without `VTA_OPENCLAW_ISOLATED=true`.

The isolation booleans document an external deployment fact. They do not build a
container, user namespace, seccomp profile, network policy, or filesystem
allowlist.

Inspect redacted configuration:

```bash
virtual-ta config-check
```

## Legacy deployment configuration

`course-ta-deploy --env-file PATH` reads a conservative dotenv subset: no shell
execution or interpolation, only known keys, and process environment/CLI
overrides where supported.

### Profile and OpenClaw

| Variable | Default | Meaning |
|---|---|---|
| `COURSE_TA_PROFILE` | `course-ta` | OpenClaw profile name |
| `COURSE_TA_STATE_DIR` | `~/.openclaw-<profile>` | Private runtime state directory |
| `COURSE_TA_WORKSPACE_DIR` | `<state>/workspace` | OpenClaw workspace |
| `COURSE_TA_SKILL_SOURCE` | bundled skill | Optional reviewed skill source path |
| `COURSE_TA_OPENCLAW_VERSION` | `2026.6.8` | npm version installed by the compatibility deployer |
| `COURSE_TA_GATEWAY_PORT` | `18790` | Local port in range 1-65535 |
| `COURSE_TA_GATEWAY_TOKEN` | empty/generated behavior | Optional fixed private gateway token |
| `COURSE_TA_INSTALL_GATEWAY` | `true` | Install/start gateway when deploying |
| `COURSE_TA_INSTALL_PYTHON_DEPS` | `true` | Install Canvas/slide helper dependencies |

### Model authentication

| Variable | Default | Meaning |
|---|---|---|
| `COURSE_TA_MODEL_AUTH` | `codex-oauth` | `codex-oauth`, `openai-api-key`, or `existing` for legacy OpenClaw |
| `COURSE_TA_MODEL` | `openai/gpt-5.5` | Legacy OpenClaw model route |
| `OPENAI_API_KEY` | empty | Required for `openai-api-key` mode |
| `CODEX_HOME` | `~/.codex` | Used to detect an existing local Codex login; never copied by the deployer |

Legacy `codex-oauth` describes OpenClaw's authentication path. It is not the V2
experimental `CodexOAuthTransport`, and neither is approved as a shared
production identity by this repository.

### Canvas

| Variable | Required | Meaning |
|---|---:|---|
| `COURSE_TA_CANVAS_BASE_URL` | Yes | HTTPS Canvas origin |
| `COURSE_TA_CANVAS_ACCESS_TOKEN` | Yes | Least-privileged course token |
| `COURSE_TA_CANVAS_COURSE_ID` | Yes | Positive numeric course ID |
| `COURSE_TA_CANVAS_SYNC_INTERVAL_HOURS` | No, default `6` | Desired positive sync interval |
| `COURSE_TA_INITIAL_CANVAS_SYNC` | No, default `true` | Run initial compatibility sync |

### Discord

| Variable | Required | Meaning |
|---|---:|---|
| `COURSE_TA_DISCORD_BOT_TOKEN` | Yes | Bot token; secret |
| `COURSE_TA_DISCORD_GUILD_ID` | Yes | 15-22 digit guild snowflake |
| `COURSE_TA_DISCORD_CHANNELS` | Yes | Allowlisted channel IDs or channel URLs |
| `COURSE_TA_DISCORD_BLOCKED_CHANNELS` | No | Explicit denylist removed from allowed channels |
| `COURSE_TA_REQUIRE_MENTION` | No, default `true` | Require a bot mention in allowed channels |
| `COURSE_TA_ADMIN_USERS` | Yes | At least one administrator snowflake |
| `COURSE_TA_PRIVILEGED_USERS_JSON` | No, default `{}` | Per-user bounded rate-limit metadata |

Wildcard channel access is not supported. URLs must belong to the configured
guild.

### Course identity and materials

| Variable | Required | Meaning |
|---|---:|---|
| `COURSE_TA_COURSE_SLUG` | Yes | Stable lowercase letters/numbers/hyphens |
| `COURSE_TA_COURSE_NAME` | Yes | Student-facing course name |
| `COURSE_TA_COURSE_SECTION` | No | Section label |
| `COURSE_TA_COURSE_CODE` | No | Course code |
| `COURSE_TA_PROFESSOR_NAME` | No | Display name, not an identity credential |
| `COURSE_TA_SEMESTER` | No | Academic term |
| `COURSE_TA_MATERIALS_DIR` | No | Local material directory outside the public repository |

## Secret handling

Do not store completed environment files in Git. For controlled deployment,
inject credentials from a managed secret service as files or service
credentials, restrict owner access, and define rotation/revocation. Never put
secrets in command-line arguments, unit files, support bundles, screenshots, or
health-check output.

`.env.example` contains placeholders and documents both configuration domains.
It is not a production secret-delivery design.
