"""Audit and health ports."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from types import MappingProxyType
from typing import Any, Mapping, Protocol

from ..domain.models import HealthReport


@dataclass(frozen=True, slots=True)
class AuditEvent:
    event_type: str
    occurred_at: datetime
    trace_id: str
    request_id: str
    tenant_id: str
    course_id: str
    actor_digest: str
    outcome: str
    details: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "details", MappingProxyType(dict(self.details)))


class AuditSink(Protocol):
    async def record(self, event: AuditEvent) -> None: ...


class HealthProbe(Protocol):
    name: str
    critical: bool

    async def probe(self) -> HealthReport: ...
