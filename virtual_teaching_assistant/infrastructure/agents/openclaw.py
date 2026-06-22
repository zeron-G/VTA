"""OpenClaw emergency backend behind a non-CLI client boundary."""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Protocol

from ...domain.models import (
    AgentResult,
    AgentTier,
    Capability,
    CapabilityEnvelope,
    DataClassification,
    HealthReport,
    TeachingRequest,
)


class OpenClawClient(Protocol):
    async def complete(
        self,
        request: TeachingRequest,
        envelope: CapabilityEnvelope,
    ) -> AgentResult: ...

    async def health(self) -> HealthReport: ...


class OpenClawAgentBackend:
    name = "openclaw"
    tier = AgentTier.OPENCLAW
    capabilities = frozenset(
        {Capability.REASON, Capability.COURSE_READ, Capability.RESPONSE_DRAFT}
    )
    max_data_classification = DataClassification.INTERNAL

    def __init__(self, client: OpenClawClient) -> None:
        self._client = client

    async def invoke(
        self,
        request: TeachingRequest,
        envelope: CapabilityEnvelope,
    ) -> AgentResult:
        return await self._client.complete(request, envelope)

    async def probe(self) -> HealthReport:
        started = time.monotonic()
        report = await self._client.health()
        if report.latency_ms:
            return report
        return HealthReport(
            component=report.component,
            status=report.status,
            checked_at=report.checked_at or datetime.now(UTC),
            latency_ms=round((time.monotonic() - started) * 1000),
            detail=report.detail,
            critical=report.critical,
            metadata=report.metadata,
        )
