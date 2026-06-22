"""Concurrent component health supervision with bounded probes."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Iterable

from ...domain.models import HealthReport, HealthStatus
from ...ports.observability import HealthProbe


@dataclass(frozen=True, slots=True)
class ProbeRegistration:
    probe: HealthProbe
    timeout_seconds: float = 5.0
    critical: bool = True

    def __post_init__(self) -> None:
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")


@dataclass(frozen=True, slots=True)
class HealthSnapshot:
    status: HealthStatus
    checked_at: datetime
    reports: tuple[HealthReport, ...]


class HealthSupervisor:
    def __init__(self, registrations: Iterable[ProbeRegistration]) -> None:
        self._registrations = tuple(registrations)

    async def snapshot(self) -> HealthSnapshot:
        reports = await asyncio.gather(
            *(self._run(registration) for registration in self._registrations)
        )
        critical_failed = any(
            report.critical and report.status is HealthStatus.FAILED for report in reports
        )
        degraded = any(
            report.status in {HealthStatus.DEGRADED, HealthStatus.FAILED}
            for report in reports
        )
        status = (
            HealthStatus.FAILED
            if critical_failed
            else HealthStatus.DEGRADED
            if degraded
            else HealthStatus.OK
        )
        return HealthSnapshot(
            status=status,
            checked_at=datetime.now(UTC),
            reports=tuple(reports),
        )

    async def _run(self, registration: ProbeRegistration) -> HealthReport:
        started = time.monotonic()
        try:
            report = await asyncio.wait_for(
                registration.probe.probe(),
                timeout=registration.timeout_seconds,
            )
            return HealthReport(
                component=report.component,
                status=report.status,
                checked_at=report.checked_at,
                latency_ms=report.latency_ms,
                detail=report.detail,
                critical=registration.critical,
                metadata=report.metadata,
            )
        except asyncio.TimeoutError:
            detail = "health probe timed out"
        except Exception:
            detail = "health probe failed"
        return HealthReport(
            component=getattr(registration.probe, "name", "unknown"),
            status=HealthStatus.FAILED,
            checked_at=datetime.now(UTC),
            latency_ms=round((time.monotonic() - started) * 1000),
            detail=detail,
            critical=registration.critical,
        )
