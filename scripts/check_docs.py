"""Validate repository-relative links and image sources in Markdown files."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote


MARKDOWN_LINK = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
HTML_TARGET = re.compile(r"<(?:a|img)\b[^>]*?\b(?:href|src)=[\"']([^\"']+)[\"']", re.I)
EXTERNAL_SCHEMES = ("http://", "https://", "mailto:", "data:")


def _target(raw: str) -> str:
    value = raw.strip()
    if value.startswith("<") and ">" in value:
        value = value[1 : value.index(">")]
    elif " \"" in value or " '" in value:
        value = value.split(" ", 1)[0]
    return unquote(value.split("#", 1)[0].split("?", 1)[0])


def check(root: Path) -> list[str]:
    errors: list[str] = []
    for document in sorted(root.rglob("*.md")):
        if any(part in {".git", ".venv", "build", "dist"} or part.endswith(".egg-info") for part in document.parts):
            continue
        text = document.read_text(encoding="utf-8")
        targets = MARKDOWN_LINK.findall(text) + HTML_TARGET.findall(text)
        for raw in targets:
            if raw.startswith("#") or raw.lower().startswith(EXTERNAL_SCHEMES):
                continue
            target = _target(raw)
            if not target:
                continue
            resolved = (document.parent / target).resolve()
            try:
                resolved.relative_to(root)
            except ValueError:
                errors.append(f"{document.relative_to(root)}: link escapes repository: {raw}")
                continue
            if not resolved.exists():
                errors.append(f"{document.relative_to(root)}: missing target: {raw}")
    return errors


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    errors = check(root)
    if errors:
        print("Documentation link check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("Documentation links are valid.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
