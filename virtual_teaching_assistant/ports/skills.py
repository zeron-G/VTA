"""Skill and classroom activity extension ports."""

from __future__ import annotations

from typing import Any, Mapping, Protocol

from ..domain.models import Capability, InteractionMode, TeachingRequest


class SkillProvider(Protocol):
    skill_id: str
    version: str
    capabilities: frozenset[Capability]

    def supports(self, request: TeachingRequest) -> bool: ...

    def instructions(self, request: TeachingRequest) -> str: ...


class ActivityPlugin(Protocol):
    activity_id: str
    modes: frozenset[InteractionMode]
    required_capabilities: frozenset[Capability]

    async def start(self, request: TeachingRequest) -> Mapping[str, Any]: ...

    async def handle(
        self,
        request: TeachingRequest,
        state: Mapping[str, Any],
    ) -> Mapping[str, Any]: ...

    async def stop(self, state: Mapping[str, Any]) -> Mapping[str, Any]: ...
