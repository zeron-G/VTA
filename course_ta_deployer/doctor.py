"""Read-only local and live health checks for a Course TA profile."""

from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .config import DeploymentConfig
from .runner import CommandResult, Runner


_VALID_STATUSES = {"ok", "failed", "skipped"}
_BAD_PROBE_STATUSES = {
    "auth",
    "billing",
    "format",
    "no_model",
    "rate_limit",
    "timeout",
    "unknown",
}


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _safe_urlopen(request: Request, *, timeout: float):
    return build_opener(_NoRedirectHandler).open(request, timeout=timeout)


@dataclass(frozen=True)
class Check:
    component: str
    name: str
    status: str
    detail: str
    duration_ms: int | None = None
    remediation: str | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "component": self.component,
            "name": self.name,
            "status": self.status,
            "ok": self.status == "ok",
            "detail": self.detail,
        }
        if self.duration_ms is not None:
            result["duration_ms"] = self.duration_ms
        if self.remediation:
            result["remediation"] = self.remediation
        return result


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _find_values(value: Any, key: str) -> list[Any]:
    found: list[Any] = []
    if isinstance(value, dict):
        for current_key, current_value in value.items():
            if current_key == key:
                found.append(current_value)
            found.extend(_find_values(current_value, key))
    elif isinstance(value, list):
        for item in value:
            found.extend(_find_values(item, key))
    return found


class HealthChecker:
    """Collect health checks without mutating Canvas, Discord, or profile data."""

    def __init__(
        self,
        config: DeploymentConfig,
        *,
        online: bool,
        timeout: float,
        runner: Runner | None = None,
        urlopen_fn: Callable[..., Any] = _safe_urlopen,
    ):
        if timeout <= 0:
            raise ValueError("timeout must be greater than zero")
        self.config = config
        self.online = online
        self.timeout = timeout
        self.runner = runner or Runner(verbose=False, secrets=config.secrets)
        self.urlopen = urlopen_fn
        self.checks: list[Check] = []
        self.openclaw: str | None = None

    def add(
        self,
        component: str,
        name: str,
        status: str,
        detail: str,
        *,
        duration_ms: int | None = None,
        remediation: str | None = None,
    ) -> None:
        if status not in _VALID_STATUSES:
            raise ValueError(f"invalid check status: {status}")
        self.checks.append(
            Check(
                component=component,
                name=name,
                status=status,
                detail=self._bounded(detail),
                duration_ms=duration_ms,
                remediation=remediation,
            )
        )

    def _bounded(self, detail: str, limit: int = 240) -> str:
        redacted = self.runner.redact(str(detail))
        compact = " ".join(redacted.split())
        return compact if len(compact) <= limit else compact[: limit - 3] + "..."

    def _profile_env(self) -> dict[str, str]:
        result = {
            "OPENCLAW_PROFILE": self.config.profile,
            "OPENCLAW_STATE_DIR": str(self.config.state_dir),
            "OPENCLAW_CONFIG_PATH": str(self.config.openclaw_config_path),
        }
        if self.config.openai_api_key:
            result["OPENAI_API_KEY"] = self.config.openai_api_key
        return result

    def _run(self, args: list[str], *, timeout: float | None = None) -> tuple[CommandResult, int]:
        started = time.monotonic()
        result = self.runner.run(
            args,
            env=self._profile_env(),
            cwd=self.config.workspace_dir if self.config.workspace_dir.exists() else None,
            check=False,
            timeout=timeout or self.timeout,
        )
        return result, round((time.monotonic() - started) * 1000)

    def _run_openclaw(self, *args: str, timeout: float | None = None) -> tuple[CommandResult, int]:
        if not self.openclaw:
            raise RuntimeError("OpenClaw is not available")
        return self._run(
            [self.openclaw, "--profile", self.config.profile, *args],
            timeout=timeout,
        )

    def _command_detail(self, result: CommandResult) -> str:
        output = result.stderr.strip() or result.stdout.strip()
        return f"exit={result.returncode}" + (f"; {self._bounded(output)}" if output else "")

    def check_local(self) -> None:
        python_ok = sys.version_info >= (3, 11)
        self.add(
            "runtime",
            "Python",
            "ok" if python_ok else "failed",
            f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            remediation=None if python_ok else "Install Python 3.11 or newer.",
        )

        node = self.runner.which("node")
        if not node:
            self.add("runtime", "Node.js", "failed", "not found on PATH", remediation="Install Node.js 22.19 or newer.")
        else:
            result, elapsed = self._run([node, "--version"])
            version_text = result.stdout.strip()
            match = re.search(r"v?(\d+)\.(\d+)", version_text)
            version_ok = bool(
                result.returncode == 0
                and match
                and (int(match.group(1)), int(match.group(2))) >= (22, 19)
            )
            self.add(
                "runtime",
                "Node.js",
                "ok" if version_ok else "failed",
                version_text or self._command_detail(result),
                duration_ms=elapsed,
                remediation=None if version_ok else "Install Node.js 22.19 or newer.",
            )

        npm = self.runner.which("npm")
        self.add(
            "runtime",
            "npm",
            "ok" if npm else "failed",
            "available on PATH" if npm else "not found on PATH",
            remediation=None if npm else "Install npm with Node.js.",
        )

        self.openclaw = self.runner.which("openclaw")
        if not self.openclaw:
            self.add(
                "openclaw",
                "OpenClaw CLI",
                "failed",
                "not found on PATH",
                remediation="Run deploy to install OpenClaw, or add it to PATH.",
            )
        else:
            result, elapsed = self._run([self.openclaw, "--version"])
            self.add(
                "openclaw",
                "OpenClaw CLI",
                "ok" if result.returncode == 0 else "failed",
                result.stdout.strip() or self._command_detail(result),
                duration_ms=elapsed,
                remediation=None if result.returncode == 0 else "Reinstall the configured OpenClaw npm package.",
            )

        paths = {
            "OpenClaw config": self.config.openclaw_config_path,
            "workspace": self.config.workspace_dir,
            "course-ta skill": self.config.skill_dir / "SKILL.md",
            "course config": self.config.skill_dir / "config" / "course-ta.json",
            "Canvas credentials": self.config.skill_dir / "data" / "credentials" / "canvas.json",
            "workspace memory": self.config.workspace_dir / "memory",
        }
        for name, path in paths.items():
            exists = path.exists()
            self.add(
                "profile",
                name,
                "ok" if exists else "failed",
                str(path),
                remediation=None if exists else "Run deploy to create the missing profile artifact.",
            )

        self._check_generated_configuration()
        self._check_model_credential_source()

        if os.name != "nt":
            for path in (self.config.openclaw_config_path, self.config.state_dir / ".env"):
                if path.exists():
                    mode = path.stat().st_mode & 0o777
                    safe = mode & 0o077 == 0
                    self.add(
                        "security",
                        f"Permissions: {path.name}",
                        "ok" if safe else "failed",
                        oct(mode),
                        remediation=None if safe else f"Run chmod 600 {path}.",
                    )

    def _check_generated_configuration(self) -> None:
        openclaw = _read_json(self.config.openclaw_config_path)
        if not openclaw:
            self.add(
                "discord",
                "Discord allowlist policy",
                "failed",
                "OpenClaw configuration is missing or invalid",
                remediation="Rerun deploy to regenerate the Discord policy.",
            )
            self.add("discord", "No Discord wildcard", "skipped", "OpenClaw configuration is unavailable")
            self.add("discord", "Discord channel routing", "skipped", "OpenClaw configuration is unavailable")
            self._check_canvas_credential_file()
            return
        discord = ((openclaw.get("channels") or {}).get("discord") or {})
        guilds = discord.get("guilds") or {}
        configured_channels = ((guilds.get(self.config.discord_guild_id) or {}).get("channels") or {})
        self.add(
            "discord",
            "Discord allowlist policy",
            "ok" if discord.get("groupPolicy") == "allowlist" else "failed",
            "groupPolicy=allowlist" if discord.get("groupPolicy") == "allowlist" else "groupPolicy must be allowlist",
            remediation="Rerun deploy to regenerate the Discord policy.",
        )
        no_wildcard = "*" not in configured_channels
        self.add(
            "discord",
            "No Discord wildcard",
            "ok" if no_wildcard else "failed",
            "no wildcard channel" if no_wildcard else "wildcard channels are not permitted",
            remediation=None if no_wildcard else "Remove the wildcard and configure explicit channel IDs.",
        )
        channels_ok = all(channel in configured_channels for channel in self.config.discord_channels)
        self.add(
            "discord",
            "Discord channel routing",
            "ok" if channels_ok else "failed",
            f"{len(self.config.discord_channels)} expected channel(s)",
            remediation=None if channels_ok else "Rerun deploy with the required Discord channel list.",
        )

        self._check_canvas_credential_file()

    def _check_canvas_credential_file(self) -> None:
        canvas = _read_json(self.config.skill_dir / "data" / "credentials" / "canvas.json")
        credential_ok = bool(canvas.get("canvas_base_url") and canvas.get("access_token"))
        self.add(
            "canvas",
            "Canvas credential file",
            "ok" if credential_ok else "failed",
            "base URL and token are populated" if credential_ok else "credential file is missing or invalid",
            remediation=None if credential_ok else "Rerun deploy with a Canvas base URL and access token.",
        )

    def _check_model_credential_source(self) -> None:
        if self.config.model_auth == "openai-api-key":
            present = bool(self.config.openai_api_key)
            self.add(
                "model",
                "OpenAI API key",
                "ok" if present else "failed",
                "configured" if present else "missing",
                remediation=None if present else "Set OPENAI_API_KEY and rerun deploy.",
            )
            return
        if self.config.model_auth == "existing":
            self.add("model", "Credential source", "ok", "existing OpenClaw profile selected")
            return

        auth_file = self.config.state_dir / "agents" / "main" / "agent" / "auth-profiles.json"
        try:
            has_profile = auth_file.is_file() and "openai-codex" in auth_file.read_text(encoding="utf-8")
        except OSError:
            has_profile = False
        self.add(
            "model",
            "Codex OAuth profile",
            "ok" if has_profile else "failed",
            "OpenClaw OAuth profile found" if has_profile else "OpenClaw OAuth profile missing",
            remediation=None if has_profile else "Run deploy without --skip-auth and complete the OAuth login.",
        )

    def _http_json(self, url: str, headers: dict[str, str]) -> tuple[Any | None, int, str | None]:
        request = Request(url, headers={"Accept": "application/json", "User-Agent": "CourseTA-Deployer/1.0", **headers}, method="GET")
        started = time.monotonic()
        try:
            with self.urlopen(request, timeout=self.timeout) as response:
                status = getattr(response, "status", response.getcode())
                payload = response.read()
            elapsed = round((time.monotonic() - started) * 1000)
            if status < 200 or status >= 300:
                return None, elapsed, f"HTTP {status}"
            try:
                return json.loads(payload.decode("utf-8")), elapsed, None
            except (UnicodeDecodeError, json.JSONDecodeError):
                return None, elapsed, "server returned invalid JSON"
        except HTTPError as exc:
            elapsed = round((time.monotonic() - started) * 1000)
            return None, elapsed, f"HTTP {exc.code} {exc.reason or ''}".strip()
        except (URLError, TimeoutError, OSError) as exc:
            elapsed = round((time.monotonic() - started) * 1000)
            reason = getattr(exc, "reason", exc)
            return None, elapsed, self._bounded(reason)

    def check_model(self) -> None:
        if not self.online:
            self.add("model", "Model authentication probe", "skipped", "online checks disabled")
            return
        if not self.openclaw:
            self.add("model", "Model authentication probe", "skipped", "OpenClaw CLI is unavailable")
            return

        if self.config.model_auth == "codex-oauth":
            provider = "openai-codex"
        else:
            provider = self.config.model.split("/", 1)[0] if "/" in self.config.model else "openai"
        timeout_ms = max(1000, round(self.timeout * 1000))
        result, elapsed = self._run_openclaw(
            "models",
            "status",
            "--json",
            "--probe",
            "--probe-provider",
            provider,
            "--probe-timeout",
            str(timeout_ms),
            "--probe-max-tokens",
            "1",
            timeout=self.timeout + 10,
        )
        statuses: list[str] = []
        if result.returncode == 0:
            try:
                payload = json.loads(result.stdout)
                statuses = [
                    str(value).lower()
                    for value in _find_values(((payload.get("auth") or {}).get("probes") or {}), "status")
                    if isinstance(value, str)
                ]
            except (AttributeError, json.JSONDecodeError):
                statuses = []
        passed = result.returncode == 0 and "ok" in statuses
        if passed:
            detail = f"provider={provider}; live probe=ok"
        elif statuses:
            known = sorted(set(status for status in statuses if status in _BAD_PROBE_STATUSES))
            detail = f"provider={provider}; live probe={','.join(known or sorted(set(statuses)))}"
        else:
            detail = f"provider={provider}; {self._command_detail(result)}"
        self.add(
            "model",
            "Model authentication probe",
            "ok" if passed else "failed",
            detail,
            duration_ms=elapsed,
            remediation=None if passed else "Refresh the configured credential and rerun check.",
        )

    def check_canvas(self) -> None:
        if not self.online:
            for name in ("Canvas API authentication", "Canvas course access", "Canvas course modules"):
                self.add("canvas", name, "skipped", "online checks disabled")
            return

        headers = {"Authorization": f"Bearer {self.config.canvas_access_token}"}
        base = self.config.canvas_base_url.rstrip("/") + "/api/v1"
        identity, elapsed, error = self._http_json(f"{base}/users/self", headers)
        identity_ok = not error and isinstance(identity, dict) and bool(identity.get("id"))
        self.add(
            "canvas",
            "Canvas API authentication",
            "ok" if identity_ok else "failed",
            "authenticated identity returned" if identity_ok else error or "identity response is incomplete",
            duration_ms=elapsed,
            remediation=None if identity_ok else "Verify the Canvas URL, token, network, and token expiry.",
        )
        if not identity_ok:
            self.add("canvas", "Canvas course access", "skipped", "Canvas authentication failed")
            self.add("canvas", "Canvas course modules", "skipped", "Canvas authentication failed")
            return

        course_url = f"{base}/courses/{self.config.canvas_course_id}"
        course, elapsed, error = self._http_json(course_url, headers)
        course_ok = not error and isinstance(course, dict) and str(course.get("id")) == str(self.config.canvas_course_id)
        self.add(
            "canvas",
            "Canvas course access",
            "ok" if course_ok else "failed",
            "configured course is readable" if course_ok else error or "course response does not match the configured ID",
            duration_ms=elapsed,
            remediation=None if course_ok else "Verify the Canvas course ID and token enrollment/permissions.",
        )
        if not course_ok:
            self.add("canvas", "Canvas course modules", "skipped", "configured course is not accessible")
            return

        modules, elapsed, error = self._http_json(f"{course_url}/modules?per_page=1", headers)
        modules_ok = not error and isinstance(modules, list)
        self.add(
            "canvas",
            "Canvas course modules",
            "ok" if modules_ok else "failed",
            "course content endpoint is readable" if modules_ok else error or "modules response is invalid",
            duration_ms=elapsed,
            remediation=None if modules_ok else "Grant the token read access to course modules.",
        )

    def check_discord(self) -> None:
        if not self.online:
            self.add("discord", "Discord bot authentication", "skipped", "online checks disabled")
            self.add("discord", "Discord guild access", "skipped", "online checks disabled")
            for channel in self.config.discord_channels:
                self.add("discord", f"Discord channel {channel}", "skipped", "online checks disabled")
            return

        headers = {"Authorization": f"Bot {self.config.discord_bot_token}"}
        base = "https://discord.com/api/v10"
        identity, elapsed, error = self._http_json(f"{base}/users/@me", headers)
        bot_ok = not error and isinstance(identity, dict) and bool(identity.get("id")) and identity.get("bot") is True
        self.add(
            "discord",
            "Discord bot authentication",
            "ok" if bot_ok else "failed",
            "bot identity returned" if bot_ok else error or "credential did not return a bot identity",
            duration_ms=elapsed,
            remediation=None if bot_ok else "Verify the Discord bot token and bot application.",
        )
        if not bot_ok:
            self.add("discord", "Discord guild access", "skipped", "Discord bot authentication failed")
            for channel in self.config.discord_channels:
                self.add("discord", f"Discord channel {channel}", "skipped", "Discord bot authentication failed")
            return

        guild, elapsed, error = self._http_json(f"{base}/guilds/{self.config.discord_guild_id}", headers)
        guild_ok = not error and isinstance(guild, dict) and str(guild.get("id")) == self.config.discord_guild_id
        self.add(
            "discord",
            "Discord guild access",
            "ok" if guild_ok else "failed",
            "configured guild is readable" if guild_ok else error or "guild response does not match the configured ID",
            duration_ms=elapsed,
            remediation=None if guild_ok else "Invite the bot to the guild and verify the guild ID.",
        )
        if not guild_ok:
            for channel in self.config.discord_channels:
                self.add("discord", f"Discord channel {channel}", "skipped", "configured guild is not accessible")
            return

        for channel in self.config.discord_channels:
            payload, elapsed, error = self._http_json(f"{base}/channels/{channel}", headers)
            channel_ok = (
                not error
                and isinstance(payload, dict)
                and str(payload.get("id")) == channel
                and str(payload.get("guild_id")) == self.config.discord_guild_id
            )
            self.add(
                "discord",
                f"Discord channel {channel}",
                "ok" if channel_ok else "failed",
                "channel is readable in the configured guild" if channel_ok else error or "channel is outside the configured guild",
                duration_ms=elapsed,
                remediation=None if channel_ok else "Verify the channel ID and the bot's View Channel permission.",
            )

    def check_openclaw_services(self) -> None:
        names = ("Gateway status", "Discord adapter probe", "Memory index status")
        if not self.online:
            for name in names:
                self.add("openclaw", name, "skipped", "online checks disabled")
            return
        if not self.openclaw:
            for name in names:
                self.add("openclaw", name, "skipped", "OpenClaw CLI is unavailable")
            return

        if not self.config.install_gateway:
            self.add("openclaw", "Gateway status", "skipped", "gateway installation is disabled by configuration")
            self.add("openclaw", "Discord adapter probe", "skipped", "gateway installation is disabled by configuration")
        else:
            result, elapsed = self._run_openclaw("gateway", "status")
            self.add(
                "openclaw",
                "Gateway status",
                "ok" if result.returncode == 0 else "failed",
                "gateway status command succeeded" if result.returncode == 0 else self._command_detail(result),
                duration_ms=elapsed,
                remediation=None if result.returncode == 0 else "Start or repair the OpenClaw gateway service.",
            )
            result, elapsed = self._run_openclaw(
                "channels", "status", "--json", "--probe", "--timeout", str(max(1000, round(self.timeout * 1000)))
            )
            self.add(
                "openclaw",
                "Discord adapter probe",
                "ok" if result.returncode == 0 else "failed",
                "OpenClaw channel probe succeeded" if result.returncode == 0 else self._command_detail(result),
                duration_ms=elapsed,
                remediation=None if result.returncode == 0 else "Check the gateway Discord channel configuration and logs.",
            )

        result, elapsed = self._run_openclaw("memory", "status", "--json")
        self.add(
            "openclaw",
            "Memory index status",
            "ok" if result.returncode == 0 else "failed",
            "memory status command succeeded" if result.returncode == 0 else self._command_detail(result),
            duration_ms=elapsed,
            remediation=None if result.returncode == 0 else "Run openclaw memory index --force for this profile.",
        )

    def run(self) -> dict[str, Any]:
        started = time.monotonic()
        self.check_local()
        self.check_model()
        self.check_canvas()
        self.check_discord()
        self.check_openclaw_services()
        counts = {status: sum(check.status == status for check in self.checks) for status in sorted(_VALID_STATUSES)}
        return {
            "ok": counts["failed"] == 0,
            "mode": "online" if self.online else "offline",
            "profile": self.config.profile,
            "summary": counts,
            "duration_ms": round((time.monotonic() - started) * 1000),
            "checks": [check.to_dict() for check in self.checks],
        }


def run_check(
    config: DeploymentConfig,
    *,
    online: bool = True,
    timeout: float = 15,
    runner: Runner | None = None,
    urlopen_fn: Callable[..., Any] = _safe_urlopen,
) -> dict[str, Any]:
    return HealthChecker(
        config,
        online=online,
        timeout=timeout,
        runner=runner,
        urlopen_fn=urlopen_fn,
    ).run()


def run_doctor(config: DeploymentConfig, *, probe: bool = False, timeout: float = 15) -> dict[str, Any]:
    """Backward-compatible doctor wrapper; use check for online checks by default."""
    return run_check(config, online=probe, timeout=timeout)
