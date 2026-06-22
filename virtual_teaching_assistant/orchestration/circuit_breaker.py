"""Deterministic circuit breaker with injectable time."""

from __future__ import annotations

import time
from dataclasses import dataclass
from enum import Enum
from typing import Callable


class CircuitState(str, Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


@dataclass(frozen=True, slots=True)
class CircuitBreakerConfig:
    failure_threshold: int = 3
    recovery_timeout_seconds: float = 30.0

    def __post_init__(self) -> None:
        if self.failure_threshold <= 0:
            raise ValueError("failure_threshold must be positive")
        if self.recovery_timeout_seconds <= 0:
            raise ValueError("recovery_timeout_seconds must be positive")


@dataclass(frozen=True, slots=True)
class CircuitSnapshot:
    state: CircuitState
    consecutive_failures: int
    opened_at: float | None


class CircuitBreaker:
    def __init__(
        self,
        config: CircuitBreakerConfig | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.config = config or CircuitBreakerConfig()
        self._clock = clock
        self._state = CircuitState.CLOSED
        self._consecutive_failures = 0
        self._opened_at: float | None = None
        self._half_open_in_flight = False

    def allow_request(self) -> bool:
        if self._state is CircuitState.CLOSED:
            return True
        if self._state is CircuitState.HALF_OPEN:
            if self._half_open_in_flight:
                return False
            self._half_open_in_flight = True
            return True
        assert self._opened_at is not None
        if self._clock() - self._opened_at < self.config.recovery_timeout_seconds:
            return False
        self._state = CircuitState.HALF_OPEN
        self._half_open_in_flight = True
        return True

    def record_success(self) -> None:
        self._state = CircuitState.CLOSED
        self._consecutive_failures = 0
        self._opened_at = None
        self._half_open_in_flight = False

    def record_failure(self) -> None:
        self._half_open_in_flight = False
        self._consecutive_failures += 1
        if (
            self._state is CircuitState.HALF_OPEN
            or self._consecutive_failures >= self.config.failure_threshold
        ):
            self._state = CircuitState.OPEN
            self._opened_at = self._clock()

    def snapshot(self) -> CircuitSnapshot:
        return CircuitSnapshot(
            state=self._state,
            consecutive_failures=self._consecutive_failures,
            opened_at=self._opened_at,
        )
