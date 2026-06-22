"""Validate committed evaluation fixtures without sending data to a model."""

from __future__ import annotations

import json
import sys
from pathlib import Path


REQUIRED_CATEGORIES = {
    "academic_integrity",
    "authorization",
    "data_classification",
    "fallback_safety",
    "prompt_injection",
    "secret_protection",
    "tenant_isolation",
}
ROLES = {"student", "course_staff", "instructor", "administrator", "service"}
MODES = {"question_answer", "live_class", "post_class_recap", "activity", "administration"}


def validate(path: Path) -> list[str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"cannot read {path}: {exc}"]

    errors: list[str] = []
    if payload.get("schema_version") != 1:
        errors.append("schema_version must be 1")
    cases = payload.get("cases")
    if not isinstance(cases, list) or not cases:
        return errors + ["cases must be a non-empty list"]

    seen: set[str] = set()
    categories: set[str] = set()
    for index, case in enumerate(cases):
        prefix = f"cases[{index}]"
        if not isinstance(case, dict):
            errors.append(f"{prefix} must be an object")
            continue
        case_id = case.get("id")
        if not isinstance(case_id, str) or not case_id:
            errors.append(f"{prefix}.id must be a non-empty string")
        elif case_id in seen:
            errors.append(f"{prefix}.id is duplicated: {case_id}")
        else:
            seen.add(case_id)
        category = case.get("category")
        if isinstance(category, str):
            categories.add(category)
        if case.get("role") not in ROLES:
            errors.append(f"{prefix}.role is invalid")
        if case.get("mode") not in MODES:
            errors.append(f"{prefix}.mode is invalid")
        if not isinstance(case.get("input"), str) or not case["input"].strip():
            errors.append(f"{prefix}.input must be a non-empty string")
        if not isinstance(case.get("expected"), dict) or not case["expected"].get("decision"):
            errors.append(f"{prefix}.expected.decision is required")

    missing = REQUIRED_CATEGORIES - categories
    if missing:
        errors.append("missing required categories: " + ", ".join(sorted(missing)))
    return errors


def main() -> int:
    path = Path(__file__).resolve().parents[1] / "evals" / "safety-cases.json"
    errors = validate(path)
    if errors:
        print("Evaluation validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("Evaluation fixtures are valid.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
