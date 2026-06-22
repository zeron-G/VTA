"""Bounded subprocess execution with environment allowlisting."""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Protocol, Sequence


_ENV_ALLOWLIST = frozenset(
    {
        "PATH",
        "HOME",
        "USERPROFILE",
        "SYSTEMROOT",
        "COMSPEC",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "CODEX_HOME",
    }
)


@dataclass(frozen=True, slots=True)
class ProcessResult:
    command: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str


class ProcessExecutor(Protocol):
    async def run(
        self,
        command: Sequence[str],
        *,
        stdin_text: str,
        cwd: Path,
        environment: Mapping[str, str],
        timeout_seconds: float,
    ) -> ProcessResult: ...


def minimal_environment(extra: Mapping[str, str] | None = None) -> dict[str, str]:
    result = {name: value for name, value in os.environ.items() if name in _ENV_ALLOWLIST}
    for name, value in (extra or {}).items():
        if name not in {"CODEX_API_KEY", "CODEX_HOME"}:
            raise ValueError(f"Environment variable {name} is not allowed for agent workers")
        result[name] = str(value)
    return result


class SubprocessExecutor:
    def __init__(self, *, output_limit_bytes: int = 4 * 1024 * 1024) -> None:
        if output_limit_bytes <= 0:
            raise ValueError("output_limit_bytes must be positive")
        self.output_limit_bytes = output_limit_bytes

    async def run(
        self,
        command: Sequence[str],
        *,
        stdin_text: str,
        cwd: Path,
        environment: Mapping[str, str],
        timeout_seconds: float,
    ) -> ProcessResult:
        if not cwd.is_dir():
            raise FileNotFoundError(f"Agent working directory does not exist: {cwd}")
        process = await asyncio.create_subprocess_exec(
            *[str(part) for part in command],
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(cwd),
            env=minimal_environment(environment),
        )
        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(stdin_text.encode("utf-8")),
                timeout=timeout_seconds,
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise
        if len(stdout_bytes) + len(stderr_bytes) > self.output_limit_bytes:
            raise RuntimeError("Agent worker output exceeded the configured limit")
        return ProcessResult(
            command=tuple(str(part) for part in command),
            returncode=process.returncode or 0,
            stdout=stdout_bytes.decode("utf-8", errors="replace"),
            stderr=stderr_bytes.decode("utf-8", errors="replace"),
        )
