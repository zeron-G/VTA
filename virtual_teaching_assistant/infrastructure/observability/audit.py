"""Append-only JSONL audit sinks that never log raw teaching content."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any, Mapping

from ...ports.observability import AuditEvent


_SECRET_KEYS = ("token", "secret", "password", "authorization", "api_key", "auth")


def _sanitize(value: Any, *, depth: int = 0) -> Any:
    if depth > 4:
        return "<max-depth>"
    if isinstance(value, Mapping):
        result = {}
        for key, child in value.items():
            normalized = str(key).lower()
            result[str(key)] = (
                "<redacted>"
                if any(marker in normalized for marker in _SECRET_KEYS)
                else _sanitize(child, depth=depth + 1)
            )
        return result
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_sanitize(item, depth=depth + 1) for item in list(value)[:64]]
    if isinstance(value, str):
        return value if len(value) <= 256 else value[:253] + "..."
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return type(value).__name__


def _event_dict(event: AuditEvent) -> dict[str, Any]:
    return {
        "event_type": event.event_type,
        "occurred_at": event.occurred_at.isoformat(),
        "trace_id": event.trace_id,
        "request_id": event.request_id,
        "tenant_id": event.tenant_id,
        "course_id": event.course_id,
        "actor_digest": event.actor_digest,
        "outcome": event.outcome,
        "details": _sanitize(event.details),
    }


class InMemoryAuditSink:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    async def record(self, event: AuditEvent) -> None:
        self.events.append(_event_dict(event))


class JsonlAuditSink:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = asyncio.Lock()

    async def record(self, event: AuditEvent) -> None:
        serialized = json.dumps(_event_dict(event), separators=(",", ":"), sort_keys=True)
        async with self._lock:
            await asyncio.to_thread(self._append, serialized)

    def _append(self, serialized: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(
            self.path,
            os.O_APPEND | os.O_CREAT | os.O_WRONLY,
            0o600,
        )
        try:
            os.write(descriptor, (serialized + "\n").encode("utf-8"))
        finally:
            os.close(descriptor)
