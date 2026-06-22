"""Agent backend ports."""

from __future__ import annotations

from typing import Protocol

from ..domain.models import (
    AgentResult,
    AgentTier,
    Capability,
    CapabilityEnvelope,
    DataClassification,
    HealthReport,
    TeachingRequest,
)


class AgentBackend(Protocol):
    name: str
    tier: AgentTier
    capabilities: frozenset[Capability]
    max_data_classification: DataClassification

    async def invoke(
        self,
        request: TeachingRequest,
        envelope: CapabilityEnvelope,
    ) -> AgentResult: ...

    async def probe(self) -> HealthReport: ...


class NativeAgentEngine(Protocol):
    async def generate(
        self,
        request: TeachingRequest,
        envelope: CapabilityEnvelope,
    ) -> AgentResult: ...
