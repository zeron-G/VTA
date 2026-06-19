"""Deployment orchestration for an isolated OpenClaw Course TA profile."""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from .builders import (
    canvas_config,
    canvas_credentials,
    course_ta_config,
    openclaw_config,
    per_course_config,
    workspace_agents,
)
from .config import ConfigError, DeploymentConfig
from .runner import CommandError, Runner


class DeploymentError(RuntimeError):
    pass


def _json(data: dict) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DeploymentError(f"Cannot read JSON file {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise DeploymentError(f"Expected a JSON object in {path}")
    return value


class SafeWriter:
    def __init__(self, state_dir: Path, *, dry_run: bool):
        self.dry_run = dry_run
        self.backup_root = state_dir / "deployment-backups" / time.strftime("%Y%m%dT%H%M%S")
        self.changed: list[str] = []

    def ensure_dir(self, path: Path, mode: int = 0o700) -> None:
        if self.dry_run:
            return
        path.mkdir(parents=True, exist_ok=True)
        try:
            path.chmod(mode)
        except OSError:
            pass

    def _backup(self, path: Path) -> None:
        if not path.exists() or path.is_symlink():
            return
        relative = Path(*path.parts[1:]) if path.is_absolute() else path
        destination = self.backup_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if path.is_dir():
            shutil.copytree(path, destination, dirs_exist_ok=True)
        else:
            shutil.copy2(path, destination)

    def write_text(self, path: Path, content: str, mode: int = 0o600) -> bool:
        try:
            if path.exists() and path.is_file() and path.read_text(encoding="utf-8") == content:
                return False
        except OSError:
            pass
        self.changed.append(str(path))
        if self.dry_run:
            return True
        self.ensure_dir(path.parent)
        self._backup(path)
        temp = path.with_name(f".{path.name}.deploy-tmp")
        temp.write_text(content, encoding="utf-8")
        try:
            temp.chmod(mode)
        except OSError:
            pass
        os.replace(temp, path)
        return True

    def copy_file(self, source: Path, destination: Path, mode: int | None = None) -> bool:
        data = source.read_bytes()
        if destination.exists() and destination.is_file():
            try:
                if destination.read_bytes() == data:
                    return False
            except OSError:
                pass
        self.changed.append(str(destination))
        if self.dry_run:
            return True
        self.ensure_dir(destination.parent)
        self._backup(destination)
        temp = destination.with_name(f".{destination.name}.deploy-tmp")
        temp.write_bytes(data)
        shutil.copystat(source, temp)
        if mode is not None:
            try:
                temp.chmod(mode)
            except OSError:
                pass
        os.replace(temp, destination)
        return True


class Linker:
    def __init__(self, runner: Runner, writer: SafeWriter, *, force: bool):
        self.runner = runner
        self.writer = writer
        self.force = force

    @staticmethod
    def _same_link(link: Path, target: Path) -> bool:
        if link.is_symlink():
            try:
                return link.resolve() == target.resolve()
            except OSError:
                return False
        if link.exists() and target.exists():
            try:
                return os.path.samefile(link, target)
            except OSError:
                return False
        return False

    def _prepare(self, link: Path, target: Path) -> bool:
        if self._same_link(link, target):
            return False
        if link.exists() or link.is_symlink():
            if not self.force:
                raise DeploymentError(
                    f"Refusing to replace existing workspace path without --force: {link}"
                )
            if not self.writer.dry_run:
                self.writer._backup(link)
                if link.is_dir() and not link.is_symlink():
                    shutil.rmtree(link)
                else:
                    link.unlink()
        if not self.writer.dry_run:
            link.parent.mkdir(parents=True, exist_ok=True)
        return True

    def create(self, link: Path, target: Path, *, directory: bool) -> None:
        if not self._prepare(link, target):
            return
        self.writer.changed.append(str(link))
        if self.writer.dry_run:
            return
        if os.name != "nt":
            relative = os.path.relpath(target, link.parent)
            link.symlink_to(relative, target_is_directory=directory)
            return
        if not directory:
            try:
                link.symlink_to(target, target_is_directory=False)
            except OSError as exc:
                raise DeploymentError(
                    "Windows file symlink creation failed. Enable Developer Mode or run the "
                    "deployment terminal as Administrator; copying or hardlinking these live "
                    "configuration files would create split sources of truth."
                ) from exc
            return
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError:
            command = ["cmd", "/c", "mklink", "/J", str(link), str(target)]
            self.runner.run(command)


@dataclass
class DeploymentOptions:
    dry_run: bool = False
    force: bool = False
    skip_openclaw_install: bool = False
    skip_auth: bool = False
    skip_canvas_sync: bool = False
    skip_gateway: bool = False


class Deployer:
    PYTHON_DEPENDENCIES = ("requests>=2.31", "beautifulsoup4>=4.12", "python-pptx>=0.6.23")
    MATERIAL_EXTENSIONS = {".md", ".txt", ".pdf", ".pptx", ".docx", ".csv", ".ipynb"}

    def __init__(self, config: DeploymentConfig, options: DeploymentOptions):
        self.config = config
        self.options = options
        self.runner = Runner(dry_run=options.dry_run, secrets=config.secrets)
        self.writer = SafeWriter(config.state_dir, dry_run=options.dry_run)
        self.linker = Linker(self.runner, self.writer, force=options.force)
        self.openclaw_bin: str | None = None

    def plan(self) -> dict:
        return {
            "configuration": self.config.redacted(),
            "codex_auth_file_detected": (self.config.codex_home / "auth.json").exists(),
            "steps": [
                "validate prerequisites",
                "install OpenClaw from npm" if not self.options.skip_openclaw_install else "use existing OpenClaw",
                "install clean course-ta skill",
                "write isolated profile and credentials",
                "link workspace to canonical skill data",
                "complete model authentication" if not self.options.skip_auth else "skip model authentication",
                "sync Canvas and index memory" if not self.options.skip_canvas_sync else "skip Canvas sync",
                "install and probe gateway" if not self.options.skip_gateway else "skip gateway setup",
                "write redacted deployment report",
            ],
        }

    def validate_local_inputs(self) -> None:
        required = (self.config.skill_source / "SKILL.md", self.config.skill_source / "lib" / "paths.py")
        missing = [str(path) for path in required if not path.is_file()]
        if missing:
            raise ConfigError(f"Invalid COURSE_TA_SKILL_SOURCE; missing: {', '.join(missing)}")
        if self.config.materials_dir and not self.config.materials_dir.is_dir():
            raise ConfigError(f"COURSE_TA_MATERIALS_DIR is not a directory: {self.config.materials_dir}")
        if self.config.state_dir == self.config.skill_source or self.config.skill_source in self.config.state_dir.parents:
            raise ConfigError("State directory may not contain or equal the source skill")

    def _profile_env(self) -> dict[str, str]:
        result = {
            "OPENCLAW_PROFILE": self.config.profile,
            "OPENCLAW_STATE_DIR": str(self.config.state_dir),
            "OPENCLAW_CONFIG_PATH": str(self.config.openclaw_config_path),
        }
        if self.config.openai_api_key:
            result["OPENAI_API_KEY"] = self.config.openai_api_key
        return result

    def _openclaw_args(self, *args: str) -> list[str]:
        if not self.openclaw_bin:
            raise DeploymentError("OpenClaw executable has not been resolved")
        return [self.openclaw_bin, "--profile", self.config.profile, *args]

    def ensure_openclaw(self) -> None:
        node = self.runner.which("node")
        npm = self.runner.which("npm")
        existing = self.runner.which("openclaw")
        if self.options.dry_run:
            node = node or "node"
            npm = npm or "npm"
            self.runner.run([node, "--version"])
            if not existing and not self.options.skip_openclaw_install:
                self.runner.run([npm, "install", "-g", f"openclaw@{self.config.openclaw_version}"])
            self.openclaw_bin = existing or "openclaw"
            self.runner.run([self.openclaw_bin, "--version"])
            return
        if self.options.skip_openclaw_install:
            if not existing:
                raise DeploymentError("--skip-openclaw-install was set but openclaw is not on PATH")
            self.openclaw_bin = existing
            return
        if not node or not npm:
            raise DeploymentError(
                "Node.js and npm are required. Install Node.js 22.19 or newer, then rerun deployment."
            )
        version_result = self.runner.run([node, "--version"])
        version_text = version_result.stdout.strip() or "v0.0.0"
        match = re.search(r"v?(\d+)\.(\d+)", version_text)
        if not match or (int(match.group(1)), int(match.group(2))) < (22, 19):
            raise DeploymentError(f"OpenClaw requires Node.js >=22.19; found {version_text}")
        if existing and self.config.openclaw_version != "latest":
            installed_result = self.runner.run([existing, "--version"])
            installed_text = installed_result.stdout.strip()
            installed_match = re.search(
                r"\b(\d{4}\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b",
                installed_text,
            )
            installed_version = installed_match.group(1) if installed_match else "unknown"
            if installed_version != self.config.openclaw_version:
                print(
                    f"Updating OpenClaw {installed_version} to "
                    f"{self.config.openclaw_version}."
                )
                existing = None
        if not existing:
            self.runner.run([npm, "install", "-g", f"openclaw@{self.config.openclaw_version}"])
            existing = self.runner.which("openclaw")
            if not existing:
                prefix_result = self.runner.run([npm, "prefix", "-g"], check=False)
                prefix = Path(prefix_result.stdout.strip()) if prefix_result.stdout.strip() else None
                if prefix:
                    candidate = prefix / ("openclaw.cmd" if os.name == "nt" else "bin/openclaw")
                    if candidate.exists():
                        existing = str(candidate)
            if not existing and not self.options.dry_run:
                raise DeploymentError("npm completed but openclaw is not available on PATH")
        self.openclaw_bin = existing or "openclaw"
        self.runner.run([self.openclaw_bin, "--version"])

    def install_python_dependencies(self) -> None:
        if not self.config.install_python_deps:
            return
        self.runner.run([sys.executable, "-m", "pip", "install", "--user", *self.PYTHON_DEPENDENCIES])

    def install_skill(self) -> None:
        excluded_parts = {"config", "data", ".git", "__pycache__"}
        for source in self.config.skill_source.rglob("*"):
            relative = source.relative_to(self.config.skill_source)
            if any(part in excluded_parts for part in relative.parts):
                continue
            if source.is_file() and source.suffix != ".pyc":
                self.writer.copy_file(source, self.config.skill_dir / relative)
        tests_source = self.config.skill_source / "data" / "tests"
        if tests_source.is_dir():
            for source in tests_source.rglob("*"):
                if source.is_file():
                    self.writer.copy_file(
                        source,
                        self.config.skill_dir / "data" / "tests" / source.relative_to(tests_source),
                    )
        for path in (
            self.config.skill_dir / "config" / "course-configs",
            self.config.skill_dir / "data" / "courses",
            self.config.skill_dir / "data" / "memory",
            self.config.skill_dir / "data" / "logs",
            self.config.skill_dir / "data" / "credentials",
            self.config.skill_dir / "data" / "tests",
            self.config.workspace_dir,
        ):
            self.writer.ensure_dir(path)

    def write_configuration(self) -> None:
        existing = _load_json(self.config.openclaw_config_path)
        generated_openclaw = openclaw_config(self.config, existing)
        self.writer.write_text(self.config.openclaw_config_path, _json(generated_openclaw))

        config_dir = self.config.skill_dir / "config"
        data_dir = self.config.skill_dir / "data"
        self.writer.write_text(config_dir / "course-ta.json", _json(course_ta_config(self.config)))
        next_canvas = canvas_config(self.config)
        previous_canvas = _load_json(config_dir / "canvas-config.json")
        previous_courses = previous_canvas.get("active_courses") or []
        if previous_courses and previous_courses[0].get("canvas_id") == self.config.canvas_course_id:
            for field_name in ("mapped_at", "last_sync"):
                next_canvas["active_courses"][0][field_name] = previous_courses[0].get(field_name)
        self.writer.write_text(config_dir / "canvas-config.json", _json(next_canvas))
        rate_state = config_dir / "ta-rate-limit.json"
        if not rate_state.exists():
            self.writer.write_text(rate_state, "{}\n")
        self.writer.write_text(
            config_dir / "course-configs" / f"{self.config.course_slug}.json",
            _json(per_course_config(self.config)),
        )
        self.writer.write_text(
            data_dir / "credentials" / "canvas.json",
            _json(canvas_credentials(self.config)),
        )
        self.writer.write_text(self.config.workspace_dir / "AGENTS.md", workspace_agents(self.config), mode=0o644)

        env_lines = [
            f"OPENCLAW_PROFILE={self.config.profile}",
            f"OPENCLAW_STATE_DIR={self.config.state_dir}",
            f"OPENCLAW_CONFIG_PATH={self.config.openclaw_config_path}",
        ]
        if self.config.openai_api_key:
            env_lines.append(f"OPENAI_API_KEY={self.config.openai_api_key}")
        self.writer.write_text(self.config.state_dir / ".env", "\n".join(env_lines) + "\n")

    def link_workspace(self) -> None:
        config_dir = self.config.skill_dir / "config"
        data_dir = self.config.skill_dir / "data"
        file_links = {
            self.config.workspace_dir / "course-ta.json": config_dir / "course-ta.json",
            self.config.workspace_dir / "canvas-config.json": config_dir / "canvas-config.json",
            self.config.workspace_dir / "ta-rate-limit.json": config_dir / "ta-rate-limit.json",
        }
        directory_links = {
            self.config.workspace_dir / "course-configs": config_dir / "course-configs",
            self.config.workspace_dir / "memory": data_dir / "memory",
            self.config.workspace_dir / "courses": data_dir / "courses",
            self.config.workspace_dir / "ta-logs": data_dir / "logs",
            self.config.workspace_dir / "ta-tests": data_dir / "tests",
        }
        for link, target in file_links.items():
            self.linker.create(link, target, directory=False)
        for link, target in directory_links.items():
            self.linker.create(link, target, directory=True)

    def import_materials(self) -> None:
        if not self.config.materials_dir:
            return
        memory = self.config.skill_dir / "data" / "memory"
        for source in self.config.materials_dir.rglob("*"):
            if source.is_file() and source.suffix.lower() in self.MATERIAL_EXTENSIONS:
                relative = source.relative_to(self.config.materials_dir)
                flat_name = "__".join(relative.parts)
                destination = memory / f"{self.config.course_slug}__uploaded__{flat_name}"
                self.writer.copy_file(source, destination, mode=0o600)

    def authenticate_model(self) -> None:
        if self.options.skip_auth or self.config.model_auth in {"existing", "openai-api-key"}:
            return
        auth_profiles = self.config.state_dir / "agents" / "main" / "agent" / "auth-profiles.json"
        if auth_profiles.exists():
            try:
                if "openai-codex" in auth_profiles.read_text(encoding="utf-8"):
                    print("Existing OpenClaw Codex OAuth profile detected; login skipped.")
                    return
            except OSError:
                pass
        print("Starting OpenClaw's interactive OpenAI Codex OAuth login.")
        self.runner.run(
            self._openclaw_args("models", "auth", "login", "--provider", "openai-codex"),
            env=self._profile_env(),
            interactive=True,
        )

    def sync_canvas_and_memory(self) -> None:
        sync_state = (
            self.config.skill_dir
            / "data"
            / "courses"
            / self.config.course_slug
            / "canvas"
            / "sync_state.json"
        )
        if (
            not self.options.skip_canvas_sync
            and self.config.initial_canvas_sync
            and not sync_state.exists()
        ):
            script = self.config.skill_dir / "lib" / "canvas_sync.py"
            self.runner.run(
                [sys.executable, str(script), "full", str(self.config.canvas_course_id)],
                cwd=self.config.workspace_dir,
                env=self._profile_env(),
            )
        elif sync_state.exists() and self.config.initial_canvas_sync:
            print("Canvas sync state already exists; initial full sync skipped.")
        if self.openclaw_bin:
            self.runner.run(
                self._openclaw_args("memory", "index", "--force"),
                env=self._profile_env(),
                cwd=self.config.workspace_dir,
            )

    def setup_gateway(self) -> None:
        if self.options.skip_gateway or not self.config.install_gateway:
            return
        self.runner.run(self._openclaw_args("gateway", "install"), env=self._profile_env())
        self.runner.run(self._openclaw_args("gateway", "restart"), env=self._profile_env(), check=False)
        self.runner.run(self._openclaw_args("gateway", "status"), env=self._profile_env())
        self.runner.run(
            self._openclaw_args("channels", "status", "--probe"),
            env=self._profile_env(),
            check=False,
        )

    def write_report(self, success: bool, error: str | None = None) -> None:
        report = {
            "success": success,
            "profile": self.config.profile,
            "state_dir": str(self.config.state_dir),
            "workspace": str(self.config.workspace_dir),
            "skill": str(self.config.skill_dir),
            "model": self.config.model,
            "model_auth": self.config.model_auth,
            "canvas_course_id": self.config.canvas_course_id,
            "discord_channels": len(self.config.discord_channels),
            "changed_paths": self.writer.changed,
            "error": self.runner.redact(error or "") or None,
        }
        self.writer.write_text(
            self.config.state_dir / "deployment-report.json",
            _json(report),
            mode=0o600,
        )

    def execute(self) -> dict:
        self.validate_local_inputs()
        try:
            self.ensure_openclaw()
            self.install_python_dependencies()
            self.install_skill()
            self.write_configuration()
            self.link_workspace()
            self.import_materials()
            self.authenticate_model()
            self.sync_canvas_and_memory()
            self.setup_gateway()
            self.write_report(True)
        except (ConfigError, CommandError, DeploymentError, OSError) as exc:
            self.write_report(False, str(exc))
            raise
        return {
            "success": True,
            "dry_run": self.options.dry_run,
            "profile": self.config.profile,
            "state_dir": str(self.config.state_dir),
            "changed_paths": self.writer.changed,
        }
