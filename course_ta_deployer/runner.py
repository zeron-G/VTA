"""Subprocess execution with dry-run support and mandatory redaction."""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping, Sequence


class CommandError(RuntimeError):
    pass


@dataclass
class CommandResult:
    args: list[str]
    returncode: int
    stdout: str = ""
    stderr: str = ""
    skipped: bool = False


class Runner:
    def __init__(self, *, dry_run: bool = False, verbose: bool = True, secrets: Iterable[str] = ()):
        self.dry_run = dry_run
        self.verbose = verbose
        self._secrets = tuple(sorted((s for s in secrets if s), key=len, reverse=True))
        self.history: list[list[str]] = []

    def redact(self, text: str) -> str:
        redacted = str(text)
        for secret in self._secrets:
            redacted = redacted.replace(secret, "<redacted>")
        return redacted

    def format_command(self, args: Sequence[str]) -> str:
        return self.redact(" ".join(shlex.quote(str(arg)) for arg in args))

    def which(self, command: str) -> str | None:
        candidates = [command]
        if os.name == "nt" and not command.lower().endswith((".exe", ".cmd", ".bat")):
            candidates.extend((f"{command}.cmd", f"{command}.exe"))
        for candidate in candidates:
            found = shutil.which(candidate)
            if found:
                return found
        return None

    def run(
        self,
        args: Sequence[str | Path],
        *,
        env: Mapping[str, str] | None = None,
        cwd: Path | None = None,
        check: bool = True,
        interactive: bool = False,
        timeout: float | None = None,
    ) -> CommandResult:
        command = [str(arg) for arg in args]
        self.history.append(command)
        if self.verbose:
            print(f"$ {self.format_command(command)}")
        if self.dry_run:
            return CommandResult(command, 0, skipped=True)

        merged_env = os.environ.copy()
        if env:
            merged_env.update({key: str(value) for key, value in env.items()})

        try:
            completed = subprocess.run(
                command,
                cwd=str(cwd) if cwd else None,
                env=merged_env,
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=not interactive,
                check=False,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            message = f"command timed out after {timeout:g}s"
            if check:
                raise CommandError(
                    f"Command timed out: {self.format_command(command)}\n{message}"
                ) from exc
            return CommandResult(command, 124, "", message)
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        if self.verbose and stdout.strip():
            print(self.redact(stdout.rstrip()))
        if self.verbose and stderr.strip():
            print(self.redact(stderr.rstrip()))
        if check and completed.returncode != 0:
            message = stderr.strip() or stdout.strip() or "command failed"
            raise CommandError(
                f"Command exited with {completed.returncode}: {self.format_command(command)}\n"
                f"{self.redact(message)}"
            )
        return CommandResult(command, completed.returncode, stdout, stderr)
