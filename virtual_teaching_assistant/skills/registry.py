"""Versioned skill manifest discovery with path containment checks."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from ..domain.models import Capability, DataClassification, InteractionMode


_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")


@dataclass(frozen=True, slots=True)
class SkillManifest:
    skill_id: str
    version: str
    root: Path
    entrypoint: Path
    modes: frozenset[InteractionMode]
    capabilities: frozenset[Capability]
    max_data_classification: DataClassification
    trusted: bool

    @classmethod
    def load(cls, manifest_path: Path) -> "SkillManifest":
        manifest_path = manifest_path.resolve()
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        root = manifest_path.parent.resolve()
        skill_id = str(data.get("id", ""))
        version = str(data.get("version", ""))
        if not _ID_RE.fullmatch(skill_id):
            raise ValueError(f"Invalid skill id in {manifest_path}")
        if not _VERSION_RE.fullmatch(version):
            raise ValueError(f"Invalid skill version in {manifest_path}")
        entrypoint = (root / str(data.get("entrypoint", "SKILL.md"))).resolve()
        try:
            entrypoint.relative_to(root)
        except ValueError as exc:
            raise ValueError("Skill entrypoint escapes its root") from exc
        if not entrypoint.is_file() or entrypoint.is_symlink():
            raise ValueError("Skill entrypoint must be a regular in-tree file")
        return cls(
            skill_id=skill_id,
            version=version,
            root=root,
            entrypoint=entrypoint,
            modes=frozenset(InteractionMode(value) for value in data.get("modes", [])),
            capabilities=frozenset(
                Capability(value) for value in data.get("capabilities", [])
            ),
            max_data_classification=DataClassification[
                str(data.get("max_data_classification", "INTERNAL")).upper()
            ],
            trusted=bool(data.get("trusted", False)),
        )


class SkillRegistry:
    def __init__(self) -> None:
        self._skills: dict[str, SkillManifest] = {}

    def register(self, manifest: SkillManifest) -> None:
        if not manifest.trusted:
            raise ValueError(f"Untrusted skill cannot be registered: {manifest.skill_id}")
        if manifest.skill_id in self._skills:
            raise ValueError(f"Skill already registered: {manifest.skill_id}")
        self._skills[manifest.skill_id] = manifest

    def discover(self, root: Path) -> tuple[SkillManifest, ...]:
        discovered: list[SkillManifest] = []
        for path in sorted(root.resolve().glob("*/skill.json")):
            manifest = SkillManifest.load(path)
            self.register(manifest)
            discovered.append(manifest)
        return tuple(discovered)

    def for_mode(self, mode: InteractionMode) -> tuple[SkillManifest, ...]:
        return tuple(skill for skill in self._skills.values() if mode in skill.modes)

    def get(self, skill_id: str) -> SkillManifest:
        return self._skills[skill_id]
