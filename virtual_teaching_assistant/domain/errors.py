"""Safe error taxonomy used by orchestration and adapters."""

from __future__ import annotations

from enum import Enum
from typing import Iterable


class FailureCategory(str, Enum):
    AUTHENTICATION = "authentication"
    RATE_LIMIT = "rate_limit"
    TIMEOUT = "timeout"
    UNAVAILABLE = "unavailable"
    INVALID_REQUEST = "invalid_request"
    POLICY = "policy"
    CONTENT_SAFETY = "content_safety"
    INTERNAL = "internal"


class VTAError(RuntimeError):
    """Base error whose message is safe to expose to operators."""

    def __init__(self, safe_message: str, *, category: FailureCategory) -> None:
        super().__init__(safe_message)
        self.safe_message = safe_message
        self.category = category


class ConfigurationError(VTAError):
    def __init__(self, safe_message: str) -> None:
        super().__init__(safe_message, category=FailureCategory.INVALID_REQUEST)


class PolicyDenied(VTAError):
    def __init__(self, safe_message: str = "Request denied by platform policy.") -> None:
        super().__init__(safe_message, category=FailureCategory.POLICY)


class BackendFailure(VTAError):
    def __init__(
        self,
        backend: str,
        category: FailureCategory,
        *,
        retryable: bool,
        safe_message: str | None = None,
    ) -> None:
        message = safe_message or f"Agent backend {backend} failed ({category.value})."
        super().__init__(message, category=category)
        self.backend = backend
        self.retryable = retryable


class TransportFailure(VTAError):
    def __init__(
        self,
        transport: str,
        category: FailureCategory,
        *,
        retryable: bool,
        safe_message: str | None = None,
    ) -> None:
        message = safe_message or f"LLM transport {transport} failed ({category.value})."
        super().__init__(message, category=category)
        self.transport = transport
        self.retryable = retryable


class NoBackendAvailable(VTAError):
    def __init__(self, attempted: Iterable[str]) -> None:
        self.attempted = tuple(attempted)
        super().__init__(
            "No eligible agent backend completed the request.",
            category=FailureCategory.UNAVAILABLE,
        )
