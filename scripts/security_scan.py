#!/usr/bin/env python3
"""Fail when a release tree contains likely secrets or private runtime data."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


SKIP_DIRS = {".git", ".venv", "venv", "build", "dist", "__pycache__"}
FORBIDDEN_NAMES = {
    ".env",
    "auth-profiles.json",
    "deployment-report.json",
    "openclaw.json",
}
FORBIDDEN_PARTS = {"credentials", "logs", "sessions", "workspace"}
TEXT_SUFFIXES = {
    "",
    ".cfg",
    ".ini",
    ".json",
    ".md",
    ".py",
    ".sh",
    ".toml",
    ".txt",
    ".yaml",
    ".yml",
}
PATTERNS = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "OpenAI key": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    "GitHub token": re.compile(r"\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b"),
    "AWS access key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "literal bearer token": re.compile(r"Authorization[\"']?\s*[:=]\s*[\"']Bearer [A-Za-z0-9._-]{20,}"),
    "literal bot token": re.compile(r"Authorization[\"']?\s*[:=]\s*[\"']Bot [A-Za-z0-9._-]{20,}"),
    "institution email": re.compile(r"\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|edu)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    "Windows user path": re.compile(r"[A-Za-z]:\\Users\\[^\\\s]+", re.IGNORECASE),
}


def iter_files(root: Path):
    for path in root.rglob("*"):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.is_file():
            yield path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", default=".", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    findings: list[tuple[str, str]] = []

    for path in iter_files(root):
        relative = path.relative_to(root)
        lowered_parts = {part.lower() for part in relative.parts}
        if path.name.lower() in FORBIDDEN_NAMES:
            findings.append((str(relative), "forbidden runtime filename"))
        if lowered_parts & FORBIDDEN_PARTS:
            findings.append((str(relative), "forbidden runtime directory"))
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        if relative.as_posix() == "scripts/security_scan.py":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for label, pattern in PATTERNS.items():
            if pattern.search(text):
                findings.append((str(relative), label))

    if findings:
        print("Release security scan failed. Matching contents are not printed.", file=sys.stderr)
        for path, label in sorted(set(findings)):
            print(f"- {path}: {label}", file=sys.stderr)
        return 1
    print("Release security scan passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
