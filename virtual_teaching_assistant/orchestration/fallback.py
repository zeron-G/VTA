"""Ordered, permission-monotonic agent fallback."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Callable, Iterable

from ..domain.errors import BackendFailure, FailureCategory, NoBackendAvailable
from ..domain.models import (
    AgentAttempt,
    Capability,
    TeachingRequest,
    TeachingResponse,
)
from ..ports.agents import AgentBackend
from .circuit_breaker import CircuitBreaker
from .policy import PolicyEngine


_FAILOVER_CATEGORIES = frozenset(
    {
        FailureCategory.AUTHENTICATION,
        FailureCategory.RATE_LIMIT,
        FailureCategory.TIMEOUT,
        FailureCategory.UNAVAILABLE,
        FailureCategory.INTERNAL,
    }
)


@dataclass(frozen=True, slots=True)
class BackendRegistration:
    backend: AgentBackend
    breaker: CircuitBreaker
    timeout_seconds: float = 30.0
    enabled: bool = True

    def __post_init__(self) -> None:
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")


class FallbackOrchestrator:
    def __init__(
        self,
        registrations: Iterable[BackendRegistration],
        *,
        policy: PolicyEngine | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._registrations = tuple(
            sorted(registrations, key=lambda item: int(item.backend.tier))
        )
        if len({item.backend.name for item in self._registrations}) != len(
            self._registrations
        ):
            raise ValueError("Agent backend names must be unique")
        self._policy = policy or PolicyEngine()
        self._clock = clock

    async def execute(
        self,
        request: TeachingRequest,
        requested_capabilities: frozenset[Capability] | None = None,
    ) -> TeachingResponse:
        decision = self._policy.evaluate(request, requested_capabilities)
        attempts: list[AgentAttempt] = []

        for index, registration in enumerate(self._registrations):
            backend = registration.backend
            if not registration.enabled:
                attempts.append(
                    AgentAttempt(backend.name, backend.tier, "disabled", 0)
                )
                continue
            if request.data_classification > backend.max_data_classification:
                attempts.append(
                    AgentAttempt(backend.name, backend.tier, "data_class_blocked", 0)
                )
                continue
            if not registration.breaker.allow_request():
                attempts.append(
                    AgentAttempt(backend.name, backend.tier, "circuit_open", 0)
                )
                continue

            envelope = decision.envelope.restrict(
                backend.capabilities,
                backend.max_data_classification,
                allow_side_effects=False,
            )
            if Capability.REASON not in envelope.capabilities:
                registration.breaker.record_success()
                attempts.append(
                    AgentAttempt(backend.name, backend.tier, "capability_blocked", 0)
                )
                continue

            started = self._clock()
            try:
                result = await asyncio.wait_for(
                    backend.invoke(request, envelope),
                    timeout=registration.timeout_seconds,
                )
            except asyncio.TimeoutError:
                registration.breaker.record_failure()
                attempts.append(
                    AgentAttempt(
                        backend.name,
                        backend.tier,
                        "failed",
                        self._elapsed_ms(started),
                        FailureCategory.TIMEOUT.value,
                    )
                )
                continue
            except BackendFailure as exc:
                if exc.retryable and exc.category in _FAILOVER_CATEGORIES:
                    registration.breaker.record_failure()
                    attempts.append(
                        AgentAttempt(
                            backend.name,
                            backend.tier,
                            "failed",
                            self._elapsed_ms(started),
                            exc.category.value,
                        )
                    )
                    continue
                registration.breaker.record_success()
                raise

            registration.breaker.record_success()
            attempts.append(
                AgentAttempt(
                    backend.name,
                    backend.tier,
                    "ok",
                    self._elapsed_ms(started),
                )
            )
            return TeachingResponse(
                request_id=request.request_id,
                trace_id=request.trace_id,
                content=result.content,
                backend=backend.name,
                tier=backend.tier,
                degraded=index > 0,
                attempts=tuple(attempts),
                citations=result.citations,
                proposed_actions=result.proposed_actions,
                model=result.model,
            )

        raise NoBackendAvailable(attempt.backend for attempt in attempts)

    def _elapsed_ms(self, started: float) -> int:
        return max(0, round((self._clock() - started) * 1000))
