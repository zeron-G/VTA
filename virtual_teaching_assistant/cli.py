"""Platform diagnostics CLI."""

from __future__ import annotations

import argparse
import json
import platform
import shutil
import sys
from pathlib import Path

from . import __version__
from .domain.errors import ConfigurationError
from .runtime.config import PlatformConfig
from .skills.registry import SkillRegistry


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="virtual-ta",
        description="VirtualTeachingAssistant platform diagnostics.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("version", help="print the platform version")
    commands.add_parser("architecture", help="print the active architecture policy")
    commands.add_parser("config-check", help="validate VTA environment configuration")
    commands.add_parser("self-check", help="run local, non-network platform checks")
    return parser


def _architecture(config: PlatformConfig) -> dict[str, object]:
    return {
        "name": "VirtualTeachingAssistant",
        "version": __version__,
        "architecture": "modular-monolith-with-hexagonal-ports",
        "agent_fallback_order": config.agent_order,
        "agent_side_effects": "forbidden; proposals require separate approval",
        "production_personal_oauth": "forbidden",
        "data_default": "internal",
    }


def _self_check(config: PlatformConfig) -> dict[str, object]:
    package_root = Path(__file__).resolve().parents[1]
    skill_root = package_root / "course_ta_deployer" / "skills"
    registry = SkillRegistry()
    checks: list[dict[str, object]] = []

    def add(name: str, ok: bool, detail: str) -> None:
        checks.append({"name": name, "status": "ok" if ok else "failed", "detail": detail})

    add("python", sys.version_info >= (3, 11), platform.python_version())
    manifests = registry.discover(skill_root) if skill_root.is_dir() else ()
    add("bundled-skills", bool(manifests), f"{len(manifests)} trusted skill(s)")
    add(
        "codex-cli",
        not config.enable_codex_cli or bool(shutil.which("codex")),
        "disabled" if not config.enable_codex_cli else "configured",
    )
    add(
        "openclaw",
        not config.enable_openclaw or bool(shutil.which("openclaw")),
        "disabled" if not config.enable_openclaw else "configured",
    )
    return {
        "ok": all(check["status"] == "ok" for check in checks),
        "configuration": config.redacted(),
        "checks": checks,
    }


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "version":
        print(__version__)
        return 0
    try:
        config = PlatformConfig.from_env()
    except (ConfigurationError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, indent=2), file=sys.stderr)
        return 2
    if args.command == "architecture":
        result = _architecture(config)
    elif args.command == "config-check":
        result = {"ok": True, "configuration": config.redacted()}
    else:
        result = _self_check(config)
    print(json.dumps(result, indent=2))
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
