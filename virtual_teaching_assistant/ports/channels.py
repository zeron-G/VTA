"""Communication channel ports."""

from __future__ import annotations

from typing import Any, Mapping, Protocol

from ..domain.models import HealthReport, TeachingRequest, TeachingResponse


class ChannelAdapter(Protocol):
    name: str

    async def normalize(self, payload: Mapping[str, Any]) -> TeachingRequest: ...

    async def deliver(self, response: TeachingResponse, destination: str) -> str: ...

    async def probe(self) -> HealthReport: ...
