"""Official OpenAI and explicitly experimental Codex OAuth transports."""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any

from ...domain.errors import FailureCategory, TransportFailure
from ...domain.models import DataClassification, HealthReport, HealthStatus
from ...ports.llm import LLMRequest, LLMResult


def _failure_category(exc: Exception) -> FailureCategory:
    status = getattr(exc, "status_code", None)
    if status in {401, 403}:
        return FailureCategory.AUTHENTICATION
    if status == 429:
        return FailureCategory.RATE_LIMIT
    if status in {408, 409, 500, 502, 503, 504}:
        return FailureCategory.UNAVAILABLE
    if isinstance(status, int) and 400 <= status < 500:
        return FailureCategory.INVALID_REQUEST
    name = type(exc).__name__.lower()
    if "timeout" in name:
        return FailureCategory.TIMEOUT
    if "auth" in name:
        return FailureCategory.AUTHENTICATION
    return FailureCategory.UNAVAILABLE


class OpenAIResponsesTransport:
    name = "openai-api"
    production_allowed = True
    max_data_classification = DataClassification.INTERNAL

    def __init__(
        self,
        *,
        api_key: str | None = None,
        client: Any | None = None,
    ) -> None:
        if client is None:
            try:
                from openai import AsyncOpenAI
            except ImportError as exc:
                raise RuntimeError("Install the 'openai' package to use this transport") from exc
            client = AsyncOpenAI(api_key=api_key)
        self._client = client

    async def complete(self, request: LLMRequest) -> LLMResult:
        try:
            response = await self._client.responses.create(
                model=request.model,
                instructions=request.instructions,
                input=request.input,
                store=False,
            )
        except Exception as exc:
            category = _failure_category(exc)
            raise TransportFailure(
                self.name,
                category,
                retryable=category
                in {
                    FailureCategory.AUTHENTICATION,
                    FailureCategory.RATE_LIMIT,
                    FailureCategory.TIMEOUT,
                    FailureCategory.UNAVAILABLE,
                },
            ) from exc
        content = str(getattr(response, "output_text", "") or "")
        if not content:
            raise TransportFailure(
                self.name,
                FailureCategory.INTERNAL,
                retryable=True,
                safe_message="OpenAI transport returned no text.",
            )
        usage_object = getattr(response, "usage", None)
        usage = {
            name: int(value)
            for name in ("input_tokens", "output_tokens", "total_tokens")
            if isinstance((value := getattr(usage_object, name, None)), int)
        }
        return LLMResult(
            content=content,
            model=str(getattr(response, "model", request.model)),
            transport=self.name,
            usage=usage,
        )

    async def probe(self) -> HealthReport:
        return HealthReport(
            component=self.name,
            status=HealthStatus.DEGRADED,
            checked_at=datetime.now(UTC),
            latency_ms=0,
            detail="transport configured; use a bounded live probe for connectivity",
        )


class CodexOAuthTransport:
    """Development-only adapter for the experimental codex_oauth package."""

    name = "codex-oauth-experimental"
    production_allowed = False
    max_data_classification = DataClassification.INTERNAL

    def __init__(self, *, client: Any | None = None, model: str = "gpt-5.5") -> None:
        if client is None:
            try:
                from codex_oauth import CodexOAuthClient
            except ImportError as exc:
                raise RuntimeError(
                    "Install codex_oauth explicitly for development use"
                ) from exc
            client = CodexOAuthClient(model=model)
        self._client = client
        self.model = model

    async def complete(self, request: LLMRequest) -> LLMResult:
        try:
            response = await self._client.complete(
                instructions=request.instructions,
                input=request.input,
                model=request.model or self.model,
            )
        except Exception as exc:
            category = _failure_category(exc)
            raise TransportFailure(
                self.name,
                category,
                retryable=category
                in {
                    FailureCategory.AUTHENTICATION,
                    FailureCategory.RATE_LIMIT,
                    FailureCategory.TIMEOUT,
                    FailureCategory.UNAVAILABLE,
                },
            ) from exc
        return LLMResult(
            content=str(response.content),
            model=str(response.model),
            transport=self.name,
            usage={
                "input_tokens": int(getattr(response.usage, "input_tokens", 0)),
                "output_tokens": int(getattr(response.usage, "output_tokens", 0)),
                "total_tokens": int(getattr(response.usage, "total_tokens", 0)),
            },
        )

    async def probe(self) -> HealthReport:
        started = time.monotonic()
        return HealthReport(
            component=self.name,
            status=HealthStatus.DISABLED,
            checked_at=datetime.now(UTC),
            latency_ms=round((time.monotonic() - started) * 1000),
            detail="experimental OAuth transport; disabled for production",
            critical=False,
        )
