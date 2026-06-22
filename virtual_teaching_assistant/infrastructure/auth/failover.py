"""Credential-isolated LLM transport failover."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Callable, Iterable

from ...domain.errors import FailureCategory, TransportFailure
from ...ports.llm import LLMRequest, LLMResult, LLMTransport
from ...orchestration.circuit_breaker import CircuitBreaker


_FAILOVER_CATEGORIES = frozenset(
    {
        FailureCategory.AUTHENTICATION,
        FailureCategory.RATE_LIMIT,
        FailureCategory.TIMEOUT,
        FailureCategory.UNAVAILABLE,
    }
)


@dataclass(frozen=True, slots=True)
class TransportRegistration:
    transport: LLMTransport
    breaker: CircuitBreaker
    timeout_seconds: float = 45.0
    enabled: bool = True

    def __post_init__(self) -> None:
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")


@dataclass(frozen=True, slots=True)
class TransportAttempt:
    transport: str
    outcome: str
    duration_ms: int
    failure_category: str | None = None


@dataclass(frozen=True, slots=True)
class LLMRouteResult:
    result: LLMResult
    degraded: bool
    attempts: tuple[TransportAttempt, ...]


class CredentialFailoverRouter:
    def __init__(
        self,
        registrations: Iterable[TransportRegistration],
        *,
        production: bool,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._registrations = tuple(registrations)
        if len({item.transport.name for item in self._registrations}) != len(
            self._registrations
        ):
            raise ValueError("LLM transport names must be unique")
        self.production = production
        self._clock = clock

    async def complete(self, request: LLMRequest) -> LLMRouteResult:
        attempts: list[TransportAttempt] = []
        for index, registration in enumerate(self._registrations):
            transport = registration.transport
            if not registration.enabled:
                attempts.append(TransportAttempt(transport.name, "disabled", 0))
                continue
            if self.production and not transport.production_allowed:
                attempts.append(
                    TransportAttempt(transport.name, "production_blocked", 0)
                )
                continue
            if request.data_classification > transport.max_data_classification:
                attempts.append(
                    TransportAttempt(transport.name, "data_class_blocked", 0)
                )
                continue
            if not registration.breaker.allow_request():
                attempts.append(TransportAttempt(transport.name, "circuit_open", 0))
                continue

            started = self._clock()
            try:
                result = await asyncio.wait_for(
                    transport.complete(request),
                    timeout=registration.timeout_seconds,
                )
            except asyncio.TimeoutError:
                registration.breaker.record_failure()
                attempts.append(
                    TransportAttempt(
                        transport.name,
                        "failed",
                        self._elapsed_ms(started),
                        FailureCategory.TIMEOUT.value,
                    )
                )
                continue
            except TransportFailure as exc:
                if exc.retryable and exc.category in _FAILOVER_CATEGORIES:
                    registration.breaker.record_failure()
                    attempts.append(
                        TransportAttempt(
                            transport.name,
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
                TransportAttempt(
                    transport.name,
                    "ok",
                    self._elapsed_ms(started),
                )
            )
            return LLMRouteResult(
                result=result,
                degraded=index > 0,
                attempts=tuple(attempts),
            )

        raise TransportFailure(
            "all",
            FailureCategory.UNAVAILABLE,
            retryable=True,
            safe_message="No eligible LLM transport completed the request.",
        )

    def _elapsed_ms(self, started: float) -> int:
        return max(0, round((self._clock() - started) * 1000))
