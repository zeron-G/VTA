"""Channel adapter registry for Discord and future Carey applications."""

from __future__ import annotations

from typing import Any, Mapping

from ...domain.models import TeachingRequest, TeachingResponse
from ...ports.channels import ChannelAdapter


class ChannelRegistry:
    def __init__(self) -> None:
        self._adapters: dict[str, ChannelAdapter] = {}

    def register(self, adapter: ChannelAdapter) -> None:
        name = adapter.name.strip().lower()
        if not name:
            raise ValueError("Channel adapter name may not be empty")
        if name in self._adapters:
            raise ValueError(f"Channel adapter already registered: {name}")
        self._adapters[name] = adapter

    def get(self, name: str) -> ChannelAdapter:
        normalized = name.strip().lower()
        try:
            return self._adapters[normalized]
        except KeyError as exc:
            raise KeyError(f"Unknown channel adapter: {normalized}") from exc

    async def normalize(
        self,
        name: str,
        payload: Mapping[str, Any],
    ) -> TeachingRequest:
        return await self.get(name).normalize(payload)

    async def deliver(
        self,
        name: str,
        response: TeachingResponse,
        destination: str,
    ) -> str:
        return await self.get(name).deliver(response, destination)

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._adapters))
