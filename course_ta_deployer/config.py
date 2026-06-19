"""Typed environment configuration for Course TA deployment."""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Mapping


class ConfigError(ValueError):
    """Raised when deployment configuration is incomplete or unsafe."""


_PROFILE_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$")
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")
_DISCORD_URL_RE = re.compile(
    r"^https?://(?:www\.)?(?:discord(?:app)?\.com)/channels/(\d+)/(\d+)(?:/\d+)?/?$",
    re.IGNORECASE,
)
_SNOWFLAKE_RE = re.compile(r"^\d{15,22}$")


ENV_HELP: tuple[tuple[str, str, str], ...] = (
    ("COURSE_TA_PROFILE", "course-ta", "OpenClaw profile name"),
    ("COURSE_TA_STATE_DIR", "", "Profile state directory; derived when empty"),
    ("COURSE_TA_WORKSPACE_DIR", "", "OpenClaw workspace; derived when empty"),
    ("COURSE_TA_SKILL_SOURCE", "", "Path to the source course-ta skill"),
    ("COURSE_TA_OPENCLAW_VERSION", "2026.6.8", "npm OpenClaw version"),
    ("COURSE_TA_GATEWAY_PORT", "18790", "Local gateway port"),
    ("COURSE_TA_GATEWAY_TOKEN", "", "Optional fixed gateway token"),
    ("COURSE_TA_MODEL_AUTH", "codex-oauth", "codex-oauth, openai-api-key, or existing"),
    ("COURSE_TA_MODEL", "", "Model override; derived from auth mode when empty"),
    ("OPENAI_API_KEY", "", "Required only for openai-api-key mode"),
    ("CODEX_HOME", "~/.codex", "Used only to detect an existing Codex login"),
    ("COURSE_TA_CANVAS_BASE_URL", "", "Canvas origin, for example https://school.instructure.com"),
    ("COURSE_TA_CANVAS_ACCESS_TOKEN", "", "Read-only Canvas API token"),
    ("COURSE_TA_CANVAS_COURSE_ID", "", "Numeric Canvas course ID"),
    ("COURSE_TA_CANVAS_SYNC_INTERVAL_HOURS", "6", "Desired Canvas sync interval"),
    ("COURSE_TA_DISCORD_BOT_TOKEN", "", "Discord bot token"),
    ("COURSE_TA_DISCORD_GUILD_ID", "", "Discord server ID"),
    ("COURSE_TA_DISCORD_CHANNELS", "", "Comma-separated channel IDs or channel URLs"),
    ("COURSE_TA_DISCORD_BLOCKED_CHANNELS", "", "Comma-separated blocked IDs or URLs"),
    ("COURSE_TA_REQUIRE_MENTION", "true", "Require @mention in configured channels"),
    ("COURSE_TA_ADMIN_USERS", "", "Comma-separated Discord administrator IDs"),
    ("COURSE_TA_PRIVILEGED_USERS_JSON", "{}", "JSON mapping of privileged users"),
    ("COURSE_TA_COURSE_SLUG", "", "Stable lowercase course slug"),
    ("COURSE_TA_COURSE_NAME", "", "Student-facing course name"),
    ("COURSE_TA_COURSE_SECTION", "", "Course section"),
    ("COURSE_TA_COURSE_CODE", "", "Optional course code"),
    ("COURSE_TA_PROFESSOR_NAME", "", "Professor display name"),
    ("COURSE_TA_SEMESTER", "", "Academic term"),
    ("COURSE_TA_MATERIALS_DIR", "", "Optional directory of local course materials"),
    ("COURSE_TA_INSTALL_PYTHON_DEPS", "true", "Install Canvas/slide Python dependencies"),
    ("COURSE_TA_INITIAL_CANVAS_SYNC", "true", "Run an initial Canvas sync"),
    ("COURSE_TA_INSTALL_GATEWAY", "true", "Install/start the OpenClaw gateway service"),
)

_ALIASES = {
    "COURSE_TA_CANVAS_BASE_URL": ("CANVAS_BASE_URL", "CANVAS_API_URL"),
    "COURSE_TA_CANVAS_ACCESS_TOKEN": ("CANVAS_ACCESS_TOKEN", "CANVAS_API_TOKEN"),
    "COURSE_TA_CANVAS_COURSE_ID": ("CANVAS_COURSE_ID",),
    "COURSE_TA_DISCORD_BOT_TOKEN": ("DISCORD_BOT_TOKEN",),
    "COURSE_TA_DISCORD_GUILD_ID": ("DISCORD_GUILD_ID",),
    "COURSE_TA_DISCORD_CHANNELS": ("DISCORD_CHANNEL_IDS", "DISCORD_CHANNEL_URLS"),
    "COURSE_TA_STATE_DIR": ("OPENCLAW_STATE_DIR",),
    "COURSE_TA_PROFILE": ("OPENCLAW_PROFILE",),
}

_KNOWN_ENV_NAMES = {name for name, _, _ in ENV_HELP}
for _alias_names in _ALIASES.values():
    _KNOWN_ENV_NAMES.update(_alias_names)


def load_dotenv(path: Path) -> dict[str, str]:
    """Read a conservative dotenv subset without interpolation or execution."""
    if not path.exists():
        raise ConfigError(f"Environment file does not exist: {path}")
    values: dict[str, str] = {}
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise ConfigError(f"Invalid .env line {number}: expected KEY=VALUE")
        key, value = line.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ConfigError(f"Invalid environment key on line {number}: {key!r}")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            quote = value[0]
            value = value[1:-1]
            if quote == '"':
                escapes = {"n": "\n", "r": "\r", "t": "\t", '"': '"', "\\": "\\"}
                value = re.sub(
                    r"\\(.)",
                    lambda match: escapes.get(match.group(1), match.group(0)),
                    value,
                )
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        values[key] = value
    return values


def _bool(value: str, name: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ConfigError(f"{name} must be true or false, got {value!r}")


def _positive_int(value: str, name: str, maximum: int | None = None) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer") from exc
    if parsed <= 0 or (maximum is not None and parsed > maximum):
        suffix = f" and <= {maximum}" if maximum else ""
        raise ConfigError(f"{name} must be > 0{suffix}")
    return parsed


def _csv(value: str) -> list[str]:
    return [item.strip() for item in re.split(r"[,\n;]", value) if item.strip()]


def _snowflakes(value: str, name: str, guild_id: str | None = None) -> list[str]:
    result: list[str] = []
    for item in _csv(value):
        match = _DISCORD_URL_RE.match(item)
        if match:
            url_guild, channel_id = match.groups()
            if guild_id and url_guild != guild_id:
                raise ConfigError(f"{name} contains a channel URL for a different guild")
            item = channel_id
        item = item.removeprefix("channel:")
        if not _SNOWFLAKE_RE.fullmatch(item):
            raise ConfigError(f"{name} contains an invalid Discord ID or channel URL")
        if item not in result:
            result.append(item)
    return result


def _json_object(value: str, name: str) -> dict:
    try:
        parsed = json.loads(value or "{}")
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{name} must contain valid JSON") from exc
    if not isinstance(parsed, dict):
        raise ConfigError(f"{name} must be a JSON object")
    return parsed


def _privileged_users(value: str) -> dict:
    parsed = _json_object(value, "COURSE_TA_PRIVILEGED_USERS_JSON")
    for user_id, metadata in parsed.items():
        if not _SNOWFLAKE_RE.fullmatch(str(user_id)):
            raise ConfigError("COURSE_TA_PRIVILEGED_USERS_JSON contains an invalid user ID")
        if not isinstance(metadata, dict):
            raise ConfigError("Each privileged-user entry must be a JSON object")
        for field_name in ("max_hour", "max_day"):
            if field_name in metadata and (
                not isinstance(metadata[field_name], int) or metadata[field_name] <= 0
            ):
                raise ConfigError(f"Privileged user {field_name} must be a positive integer")
    return parsed


def _default_skill_source() -> Path:
    return Path(__file__).resolve().parent / "skills" / "course-ta"


def _value(values: Mapping[str, str], name: str, default: str = "") -> str:
    if values.get(name, "").strip():
        return values[name].strip()
    for alias in _ALIASES.get(name, ()):
        if values.get(alias, "").strip():
            return values[alias].strip()
    return default


def _collect_values(
    env_file: Path | None,
    environ: Mapping[str, str] | None,
    overrides: Mapping[str, str] | None,
) -> tuple[dict[str, str], Path]:
    values: dict[str, str] = {}
    base_dir = Path.cwd()
    if env_file:
        env_file = env_file.expanduser().resolve()
        base_dir = env_file.parent
        file_values = load_dotenv(env_file)
        unknown = sorted(
            name for name in file_values if name.startswith("COURSE_TA_") and name not in _KNOWN_ENV_NAMES
        )
        if unknown:
            raise ConfigError(f"Unknown Course TA environment variable: {unknown[0]}")
        values.update({name: value for name, value in file_values.items() if name in _KNOWN_ENV_NAMES})
    process_values = environ if environ is not None else os.environ
    values.update({name: process_values[name] for name in _KNOWN_ENV_NAMES if name in process_values})
    if overrides:
        values.update(
            {key: value for key, value in overrides.items() if key in _KNOWN_ENV_NAMES and value is not None}
        )
    return values, base_dir


def missing_required_settings(
    env_file: Path | None = None,
    environ: Mapping[str, str] | None = None,
    overrides: Mapping[str, str] | None = None,
) -> list[tuple[str, str]]:
    """Return all missing required settings without retaining unrelated environment data."""
    values, _ = _collect_values(env_file, environ, overrides)
    return _missing_required_values(values)


def _is_configured_value(value: str) -> bool:
    normalized = re.sub(r"[-\s]+", "_", value.strip().upper())
    return bool(value.strip()) and "REPLACE_ME" not in normalized


def _missing_required_values(values: Mapping[str, str]) -> list[tuple[str, str]]:
    required = (
        ("canvas", "COURSE_TA_CANVAS_BASE_URL"),
        ("canvas", "COURSE_TA_CANVAS_ACCESS_TOKEN"),
        ("canvas", "COURSE_TA_CANVAS_COURSE_ID"),
        ("discord", "COURSE_TA_DISCORD_BOT_TOKEN"),
        ("discord", "COURSE_TA_DISCORD_GUILD_ID"),
        ("discord", "COURSE_TA_DISCORD_CHANNELS"),
        ("discord", "COURSE_TA_ADMIN_USERS"),
        ("course", "COURSE_TA_COURSE_SLUG"),
        ("course", "COURSE_TA_COURSE_NAME"),
    )
    missing = [
        (component, name)
        for component, name in required
        if not _is_configured_value(_value(values, name))
    ]
    auth = _value(values, "COURSE_TA_MODEL_AUTH", "codex-oauth").lower()
    if auth == "openai-api-key" and not _is_configured_value(_value(values, "OPENAI_API_KEY")):
        missing.append(("model", "OPENAI_API_KEY"))
    return missing


@dataclass(frozen=True)
class DeploymentConfig:
    profile: str
    state_dir: Path
    workspace_dir: Path
    skill_source: Path
    openclaw_version: str
    gateway_port: int
    gateway_token: str
    model_auth: str
    model: str
    openai_api_key: str
    codex_home: Path
    canvas_base_url: str
    canvas_access_token: str
    canvas_course_id: int
    canvas_sync_interval_hours: int
    discord_bot_token: str
    discord_guild_id: str
    discord_channels: list[str]
    discord_blocked_channels: list[str]
    require_mention: bool
    admin_users: list[str]
    privileged_users: dict
    course_slug: str
    course_name: str
    course_section: str
    course_code: str
    professor_name: str
    semester: str
    materials_dir: Path | None
    install_python_deps: bool
    initial_canvas_sync: bool
    install_gateway: bool
    source_env: dict[str, str] = field(repr=False, compare=False, default_factory=dict)

    @property
    def skill_dir(self) -> Path:
        return self.state_dir / "skills" / "course-ta"

    @property
    def openclaw_config_path(self) -> Path:
        return self.state_dir / "openclaw.json"

    @property
    def secrets(self) -> tuple[str, ...]:
        return tuple(
            value
            for value in (
                self.gateway_token,
                self.openai_api_key,
                self.canvas_access_token,
                self.discord_bot_token,
            )
            if value
        )

    def redacted(self) -> dict:
        data = asdict(self)
        data.pop("source_env", None)
        for key in ("gateway_token", "openai_api_key", "canvas_access_token", "discord_bot_token"):
            data[key] = "<set>" if data[key] else "<not set>"
        for key, value in list(data.items()):
            if isinstance(value, Path):
                data[key] = str(value)
        return data


def load_config(
    env_file: Path | None = None,
    environ: Mapping[str, str] | None = None,
    overrides: Mapping[str, str] | None = None,
) -> DeploymentConfig:
    values, base_dir = _collect_values(env_file, environ, overrides)
    missing = _missing_required_values(values)
    if missing:
        raise ConfigError(f"{missing[0][1]} is required and may not contain a placeholder")

    defaults = {name: default for name, default, _ in ENV_HELP}
    profile = _value(values, "COURSE_TA_PROFILE", defaults["COURSE_TA_PROFILE"])
    if not _PROFILE_RE.fullmatch(profile):
        raise ConfigError("COURSE_TA_PROFILE contains unsupported characters")

    def configured_path(raw: str) -> Path:
        path = Path(raw).expanduser()
        return path if path.is_absolute() else base_dir / path

    state_raw = _value(values, "COURSE_TA_STATE_DIR")
    state_dir = configured_path(state_raw) if state_raw else Path.home() / f".openclaw-{profile}"
    workspace_raw = _value(values, "COURSE_TA_WORKSPACE_DIR")
    workspace_dir = configured_path(workspace_raw) if workspace_raw else state_dir / "workspace"
    skill_raw = _value(values, "COURSE_TA_SKILL_SOURCE")
    skill_source = configured_path(skill_raw) if skill_raw else _default_skill_source()

    guild_id = _value(values, "COURSE_TA_DISCORD_GUILD_ID")
    if not _SNOWFLAKE_RE.fullmatch(guild_id):
        raise ConfigError("COURSE_TA_DISCORD_GUILD_ID must be a numeric Discord server ID")
    channels = _snowflakes(_value(values, "COURSE_TA_DISCORD_CHANNELS"), "COURSE_TA_DISCORD_CHANNELS", guild_id)
    blocked = _snowflakes(
        _value(values, "COURSE_TA_DISCORD_BLOCKED_CHANNELS"),
        "COURSE_TA_DISCORD_BLOCKED_CHANNELS",
        guild_id,
    )
    channels = [channel for channel in channels if channel not in blocked]
    if not channels:
        raise ConfigError("At least one allowed Discord channel is required")

    admin_users = _snowflakes(_value(values, "COURSE_TA_ADMIN_USERS"), "COURSE_TA_ADMIN_USERS")
    if not admin_users:
        raise ConfigError("At least one COURSE_TA_ADMIN_USERS entry is required")

    auth = _value(values, "COURSE_TA_MODEL_AUTH", defaults["COURSE_TA_MODEL_AUTH"]).lower()
    if auth not in {"codex-oauth", "openai-api-key", "existing"}:
        raise ConfigError("COURSE_TA_MODEL_AUTH must be codex-oauth, openai-api-key, or existing")
    api_key = _value(values, "OPENAI_API_KEY")
    if auth == "openai-api-key" and not api_key:
        raise ConfigError("OPENAI_API_KEY is required for openai-api-key mode")
    # Current OpenClaw uses canonical openai/* model refs for both API-key and
    # Codex OAuth auth. openai-codex/* is retained only as a legacy model route.
    default_model = "openai/gpt-5.5"
    model = _value(values, "COURSE_TA_MODEL", default_model)

    canvas_url = _value(values, "COURSE_TA_CANVAS_BASE_URL").rstrip("/")
    if not re.fullmatch(r"https://[^/]+(?:/.*)?", canvas_url):
        raise ConfigError("COURSE_TA_CANVAS_BASE_URL must be an https URL")
    canvas_token = _value(values, "COURSE_TA_CANVAS_ACCESS_TOKEN")
    if not canvas_token:
        raise ConfigError("COURSE_TA_CANVAS_ACCESS_TOKEN is required")

    slug = _value(values, "COURSE_TA_COURSE_SLUG")
    if not _SLUG_RE.fullmatch(slug):
        raise ConfigError("COURSE_TA_COURSE_SLUG must be lowercase letters, numbers, and hyphens")
    course_name = _value(values, "COURSE_TA_COURSE_NAME")
    if not course_name:
        raise ConfigError("COURSE_TA_COURSE_NAME is required")

    discord_token = _value(values, "COURSE_TA_DISCORD_BOT_TOKEN")
    if not discord_token:
        raise ConfigError("COURSE_TA_DISCORD_BOT_TOKEN is required")

    materials_raw = _value(values, "COURSE_TA_MATERIALS_DIR")
    materials = configured_path(materials_raw) if materials_raw else None
    gateway_token = _value(values, "COURSE_TA_GATEWAY_TOKEN")

    return DeploymentConfig(
        profile=profile,
        state_dir=state_dir.resolve(),
        workspace_dir=workspace_dir.resolve(),
        skill_source=skill_source.resolve(),
        openclaw_version=_value(values, "COURSE_TA_OPENCLAW_VERSION", "2026.6.8"),
        gateway_port=_positive_int(_value(values, "COURSE_TA_GATEWAY_PORT", "18790"), "COURSE_TA_GATEWAY_PORT", 65535),
        gateway_token=gateway_token,
        model_auth=auth,
        model=model,
        openai_api_key=api_key,
        codex_home=Path(_value(values, "CODEX_HOME", "~/.codex")).expanduser().resolve(),
        canvas_base_url=canvas_url,
        canvas_access_token=canvas_token,
        canvas_course_id=_positive_int(_value(values, "COURSE_TA_CANVAS_COURSE_ID"), "COURSE_TA_CANVAS_COURSE_ID"),
        canvas_sync_interval_hours=_positive_int(
            _value(values, "COURSE_TA_CANVAS_SYNC_INTERVAL_HOURS", "6"),
            "COURSE_TA_CANVAS_SYNC_INTERVAL_HOURS",
        ),
        discord_bot_token=discord_token,
        discord_guild_id=guild_id,
        discord_channels=channels,
        discord_blocked_channels=blocked,
        require_mention=_bool(_value(values, "COURSE_TA_REQUIRE_MENTION", "true"), "COURSE_TA_REQUIRE_MENTION"),
        admin_users=admin_users,
        privileged_users=_privileged_users(_value(values, "COURSE_TA_PRIVILEGED_USERS_JSON", "{}")),
        course_slug=slug,
        course_name=course_name,
        course_section=_value(values, "COURSE_TA_COURSE_SECTION"),
        course_code=_value(values, "COURSE_TA_COURSE_CODE"),
        professor_name=_value(values, "COURSE_TA_PROFESSOR_NAME"),
        semester=_value(values, "COURSE_TA_SEMESTER"),
        materials_dir=materials.resolve() if materials else None,
        install_python_deps=_bool(
            _value(values, "COURSE_TA_INSTALL_PYTHON_DEPS", "true"),
            "COURSE_TA_INSTALL_PYTHON_DEPS",
        ),
        initial_canvas_sync=_bool(
            _value(values, "COURSE_TA_INITIAL_CANVAS_SYNC", "true"),
            "COURSE_TA_INITIAL_CANVAS_SYNC",
        ),
        install_gateway=_bool(
            _value(values, "COURSE_TA_INSTALL_GATEWAY", "true"),
            "COURSE_TA_INSTALL_GATEWAY",
        ),
        source_env=values,
    )


def env_template() -> str:
    lines = ["# Course TA quick deployment", "# Never commit the completed file.", ""]
    secret_names = {
        "COURSE_TA_GATEWAY_TOKEN",
        "OPENAI_API_KEY",
        "COURSE_TA_CANVAS_ACCESS_TOKEN",
        "COURSE_TA_DISCORD_BOT_TOKEN",
    }
    for name, default, description in ENV_HELP:
        lines.append(f"# {description}")
        value = "" if name in secret_names else default
        lines.append(f"{name}={value}")
        lines.append("")
    return "\n".join(lines)
