"""Adapter for the future native VTA agent engine."""

from __future__ import annotations

from datetime import UTC, datetime

from ...domain.models import (
    AgentResult,
    AgentTier,
    Capability,
    CapabilityEnvelope,
    DataClassification,
    HealthReport,
    HealthStatus,
    TeachingRequest,
)
from ...ports.agents import NativeAgentEngine


class NativeAgentBackend:
    name = "native"
    tier = AgentTier.NATIVE
    capabilities = frozenset(
        {
            Capability.REASON,
            Capability.COURSE_READ,
            Capability.CANVAS_READ,
            Capability.RESPONSE_DRAFT,
            Capability.LIVE_ANALYZE,
            Capability.RECAP_DRAFT,
            Capability.ACTIVITY_PARTICIPATE,
        }
    )
    max_data_classification = DataClassification.RESTRICTED

    def __init__(self, engine: NativeAgentEngine) -> None:
        self._engine = engine

    async def invoke(
        self,
        request: TeachingRequest,
        envelope: CapabilityEnvelope,
    ) -> AgentResult:
        return await self._engine.generate(request, envelope)

    async def probe(self) -> HealthReport:
        return HealthReport(
            component=self.name,
            status=HealthStatus.OK,
            checked_at=datetime.now(UTC),
            latency_ms=0,
            detail="native engine registered",
        )
