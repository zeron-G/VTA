#!/usr/bin/env python3
"""Enforce core dependency direction using Python's AST."""

from __future__ import annotations

import ast
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "virtual_teaching_assistant"

RULES = {
    "domain": {
        "virtual_teaching_assistant.infrastructure",
        "virtual_teaching_assistant.orchestration",
        "course_ta_deployer",
        "openai",
        "requests",
        "httpx",
    },
    "ports": {
        "virtual_teaching_assistant.infrastructure",
        "virtual_teaching_assistant.orchestration",
        "course_ta_deployer",
        "openai",
        "requests",
        "httpx",
    },
    "orchestration": {
        "virtual_teaching_assistant.infrastructure",
        "course_ta_deployer",
        "openai",
        "requests",
        "httpx",
    },
}


def imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    result: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            result.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            result.add(node.module)
    return result


def main() -> int:
    failures: list[str] = []
    for layer, forbidden in RULES.items():
        for path in sorted((PACKAGE / layer).rglob("*.py")):
            for imported in imports(path):
                if any(
                    imported == prefix or imported.startswith(prefix + ".")
                    for prefix in forbidden
                ):
                    failures.append(f"{path.relative_to(ROOT)} imports {imported}")
    if failures:
        print("Architecture boundary check failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    print("Architecture boundary check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
