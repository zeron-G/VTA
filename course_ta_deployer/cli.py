"""Command-line interface for Course TA deployment."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import ConfigError, env_template, load_config, missing_required_settings
from .deployment import Deployer, DeploymentError, DeploymentOptions
from .doctor import run_check, run_doctor
from .runner import CommandError


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="course-ta-deploy",
        description="Deploy an isolated OpenClaw Course TA profile.",
    )
    parser.add_argument("--env-file", type=Path, help="dotenv configuration file")
    parser.add_argument("--profile", help="override COURSE_TA_PROFILE")
    parser.add_argument("--state-dir", help="override COURSE_TA_STATE_DIR")
    parser.add_argument("--skill-source", help="override COURSE_TA_SKILL_SOURCE")

    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("print-env", help="print a blank environment template")

    plan = commands.add_parser("plan", help="validate configuration and print a redacted plan")
    _deployment_flags(plan, include_confirmation=False)

    deploy = commands.add_parser("deploy", help="perform deployment")
    _deployment_flags(deploy, include_confirmation=True)

    doctor = commands.add_parser("doctor", help="check a deployed profile")
    doctor.add_argument("--probe", action="store_true", help="also run live connectivity checks")
    doctor.add_argument("--timeout", type=_positive_timeout, default=15.0, help="per-check timeout in seconds")

    check = commands.add_parser("check", help="run local and live read-only connectivity checks")
    check.add_argument("--offline", action="store_true", help="skip all network and live provider probes")
    check.add_argument("--timeout", type=_positive_timeout, default=15.0, help="per-check timeout in seconds")
    return parser


def _positive_timeout(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("timeout must be a number") from exc
    if parsed <= 0 or parsed > 300:
        raise argparse.ArgumentTypeError("timeout must be greater than 0 and no more than 300")
    return parsed


def _deployment_flags(parser: argparse.ArgumentParser, *, include_confirmation: bool) -> None:
    parser.add_argument("--dry-run", action="store_true", help="show commands without writing or executing")
    parser.add_argument("--force", action="store_true", help="back up and replace conflicting workspace paths")
    parser.add_argument("--skip-openclaw-install", action="store_true")
    parser.add_argument("--skip-auth", action="store_true")
    parser.add_argument("--skip-canvas-sync", action="store_true")
    parser.add_argument("--skip-gateway", action="store_true")
    if include_confirmation:
        parser.add_argument("--yes", action="store_true", help="run without an interactive confirmation")


def _overrides(args: argparse.Namespace) -> dict[str, str]:
    result = {}
    if args.profile:
        result["COURSE_TA_PROFILE"] = args.profile
    if args.state_dir:
        result["COURSE_TA_STATE_DIR"] = args.state_dir
    if args.skill_source:
        result["COURSE_TA_SKILL_SOURCE"] = args.skill_source
    return result


def _options(args: argparse.Namespace) -> DeploymentOptions:
    return DeploymentOptions(
        dry_run=getattr(args, "dry_run", False),
        force=getattr(args, "force", False),
        skip_openclaw_install=getattr(args, "skip_openclaw_install", False),
        skip_auth=getattr(args, "skip_auth", False),
        skip_canvas_sync=getattr(args, "skip_canvas_sync", False),
        skip_gateway=getattr(args, "skip_gateway", False),
    )


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "print-env":
        print(env_template())
        return 0

    try:
        if args.command in {"check", "doctor"}:
            missing = missing_required_settings(args.env_file, overrides=_overrides(args))
            if missing:
                checks = [
                    {
                        "component": component,
                        "name": name,
                        "status": "failed",
                        "ok": False,
                        "detail": "required environment value is missing or still a placeholder",
                        "remediation": f"Set {name} in the environment or .env file.",
                    }
                    for component, name in missing
                ]
                result = {
                    "ok": False,
                    "mode": "configuration",
                    "summary": {"failed": len(checks), "ok": 0, "skipped": 0},
                    "checks": checks,
                }
                print(json.dumps(result, indent=2, ensure_ascii=False))
                return 2
        config = load_config(args.env_file, overrides=_overrides(args))
        if args.command == "doctor":
            result = run_doctor(config, probe=args.probe, timeout=args.timeout)
            print(json.dumps(result, indent=2, ensure_ascii=False))
            return 0 if result["ok"] else 1
        if args.command == "check":
            result = run_check(config, online=not args.offline, timeout=args.timeout)
            print(json.dumps(result, indent=2, ensure_ascii=False))
            return 0 if result["ok"] else 1

        deployer = Deployer(config, _options(args))
        deployer.validate_local_inputs()
        plan = deployer.plan()
        print(json.dumps(plan, indent=2, ensure_ascii=False))
        if args.command == "plan":
            return 0

        if not args.yes and not args.dry_run:
            answer = input(f"Deploy profile {config.profile!r} to {config.state_dir}? [y/N] ")
            if answer.strip().lower() not in {"y", "yes"}:
                print("Deployment cancelled.")
                return 1
        result = deployer.execute()
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    except ConfigError as exc:
        if args.command in {"check", "doctor"}:
            result = {
                "ok": False,
                "mode": "configuration",
                "summary": {"failed": 1, "ok": 0, "skipped": 0},
                "checks": [
                    {
                        "component": "configuration",
                        "name": "Environment configuration",
                        "status": "failed",
                        "ok": False,
                        "detail": str(exc),
                        "remediation": "Fix the reported environment value and rerun check.",
                    }
                ],
            }
            print(json.dumps(result, indent=2, ensure_ascii=False))
            return 2
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except (DeploymentError, CommandError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
