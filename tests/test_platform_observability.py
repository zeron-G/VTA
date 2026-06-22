import asyncio
import json
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path

from virtual_teaching_assistant.domain.models import HealthReport, HealthStatus
from virtual_teaching_assistant.infrastructure.observability.audit import JsonlAuditSink
from virtual_teaching_assistant.infrastructure.observability.health import (
    HealthSupervisor,
    ProbeRegistration,
)
from virtual_teaching_assistant.ports.observability import AuditEvent


class SlowProbe:
    name = "slow"
    critical = True

    async def probe(self):
        await asyncio.sleep(0.05)
        return HealthReport(
            component="slow",
            status=HealthStatus.OK,
            checked_at=datetime.now(UTC),
            latency_ms=50,
            detail="ok",
        )


class PlatformObservabilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_audit_sink_redacts_secret_fields(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "audit.jsonl"
            sink = JsonlAuditSink(path)
            await sink.record(
                AuditEvent(
                    event_type="test",
                    occurred_at=datetime.now(UTC),
                    trace_id="trace-1",
                    request_id="request-1",
                    tenant_id="carey",
                    course_id="course-101",
                    actor_digest="digest-only",
                    outcome="ok",
                    details={"api_key": "sensitive-value", "count": 1},
                )
            )
            text = path.read_text(encoding="utf-8")
        self.assertNotIn("sensitive-value", text)
        self.assertEqual(json.loads(text)["details"]["api_key"], "<redacted>")

    async def test_health_probe_timeout_is_failed(self):
        snapshot = await HealthSupervisor(
            [ProbeRegistration(SlowProbe(), timeout_seconds=0.001)]
        ).snapshot()
        self.assertEqual(snapshot.status, HealthStatus.FAILED)
        self.assertEqual(snapshot.reports[0].detail, "health probe timed out")


if __name__ == "__main__":
    unittest.main()
