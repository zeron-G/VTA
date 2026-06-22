"""Top-level teaching use case with minimized auditing."""

from __future__ import annotations

import hashlib
import hmac
from datetime import UTC, datetime

from ..domain.models import Capability, TeachingRequest, TeachingResponse
from ..ports.observability import AuditEvent, AuditSink
from .fallback import FallbackOrchestrator


class TeachingService:
    def __init__(
        self,
        orchestrator: FallbackOrchestrator,
        audit_sink: AuditSink,
        *,
        audit_hmac_key: bytes,
    ) -> None:
        if len(audit_hmac_key) < 32:
            raise ValueError("audit_hmac_key must contain at least 32 bytes")
        self._orchestrator = orchestrator
        self._audit_sink = audit_sink
        self._audit_hmac_key = bytes(audit_hmac_key)

    async def handle(
        self,
        request: TeachingRequest,
        requested_capabilities: frozenset[Capability] | None = None,
    ) -> TeachingResponse:
        try:
            response = await self._orchestrator.execute(
                request,
                requested_capabilities,
            )
        except Exception as exc:
            await self._audit_sink.record(
                self._event(
                    request,
                    outcome="failed",
                    details={"error_type": type(exc).__name__},
                )
            )
            raise

        await self._audit_sink.record(
            self._event(
                request,
                outcome="ok",
                details={
                    "backend": response.backend,
                    "tier": str(int(response.tier)),
                    "degraded": response.degraded,
                    "input_chars": len(request.content),
                    "output_chars": len(response.content),
                    "content_digest": self._digest(request.content),
                    "attempts": len(response.attempts),
                    "proposed_actions": len(response.proposed_actions),
                },
            )
        )
        return response

    def _event(
        self,
        request: TeachingRequest,
        *,
        outcome: str,
        details: dict,
    ) -> AuditEvent:
        return AuditEvent(
            event_type="teaching.interaction",
            occurred_at=datetime.now(UTC),
            trace_id=request.trace_id,
            request_id=request.request_id,
            tenant_id=request.tenant_id,
            course_id=request.course_id,
            actor_digest=self._digest(request.actor_ref),
            outcome=outcome,
            details=details,
        )

    def _digest(self, value: str) -> str:
        return hmac.new(
            self._audit_hmac_key,
            value.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
