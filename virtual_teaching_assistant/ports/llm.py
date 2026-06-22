"""LLM transport ports independent of agent implementations."""

from __future__ import annotations

from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Mapping, Protocol

from ..domain.models import DataClassification, HealthReport


@dataclass(frozen=True, slots=True)
class LLMRequest:
    input: str
    instructions: str
    model: str
    data_classification: DataClassification
    request_id: str
    trace_id: str
    metadata: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "metadata", MappingProxyType(dict(self.metadata)))


@dataclass(frozen=True, slots=True)
class LLMResult:
    content: str
    model: str
    transport: str
    usage: Mapping[str, int] = field(default_factory=dict)
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "usage", MappingProxyType(dict(self.usage)))
        object.__setattr__(self, "raw", MappingProxyType(dict(self.raw)))


class LLMTransport(Protocol):
    name: str
    production_allowed: bool
    max_data_classification: DataClassification

    async def complete(self, request: LLMRequest) -> LLMResult: ...

    async def probe(self) -> HealthReport: ...
