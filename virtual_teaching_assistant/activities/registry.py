"""Registry for live analysis, recap, game, debate, and future activities."""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..domain.models import ActorRole, Capability, InteractionMode
from ..ports.skills import ActivityPlugin


_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


@dataclass(frozen=True, slots=True)
class ActivityDescriptor:
    activity_id: str
    display_name: str
    modes: frozenset[InteractionMode]
    required_role: ActorRole
    required_capabilities: frozenset[Capability]

    def __post_init__(self) -> None:
        if not _ID_RE.fullmatch(self.activity_id):
            raise ValueError("Invalid activity id")
        if not self.display_name.strip():
            raise ValueError("Activity display name may not be empty")


class ActivityRegistry:
    def __init__(self) -> None:
        self._plugins: dict[str, tuple[ActivityDescriptor, ActivityPlugin]] = {}

    def register(
        self,
        descriptor: ActivityDescriptor,
        plugin: ActivityPlugin,
    ) -> None:
        if descriptor.activity_id != plugin.activity_id:
            raise ValueError("Activity descriptor and plugin id differ")
        if descriptor.modes != plugin.modes:
            raise ValueError("Activity descriptor and plugin modes differ")
        if descriptor.required_capabilities != plugin.required_capabilities:
            raise ValueError("Activity capability declaration differs")
        if descriptor.activity_id in self._plugins:
            raise ValueError(f"Activity already registered: {descriptor.activity_id}")
        self._plugins[descriptor.activity_id] = (descriptor, plugin)

    def get(self, activity_id: str) -> tuple[ActivityDescriptor, ActivityPlugin]:
        return self._plugins[activity_id]

    @property
    def descriptors(self) -> tuple[ActivityDescriptor, ...]:
        return tuple(item[0] for item in self._plugins.values())
