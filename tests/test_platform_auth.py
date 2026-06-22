import unittest
from datetime import UTC, datetime

from virtual_teaching_assistant.domain.errors import FailureCategory, TransportFailure
from virtual_teaching_assistant.domain.models import DataClassification, HealthReport, HealthStatus
from virtual_teaching_assistant.infrastructure.auth.failover import (
    CredentialFailoverRouter,
    TransportRegistration,
)
from virtual_teaching_assistant.orchestration.circuit_breaker import CircuitBreaker
from virtual_teaching_assistant.ports.llm import LLMRequest, LLMResult


def request(classification=DataClassification.INTERNAL):
    return LLMRequest(
        input="Explain price discrimination.",
        instructions="Answer from course materials.",
        model="gpt-5.5",
        data_classification=classification,
        request_id="request-1",
        trace_id="trace-1",
    )


class FakeTransport:
    max_data_classification = DataClassification.INTERNAL

    def __init__(self, name, outcomes, *, production_allowed=True):
        self.name = name
        self.outcomes = list(outcomes)
        self.production_allowed = production_allowed
        self.calls = 0

    async def complete(self, item):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return LLMResult(content=outcome, model=item.model, transport=self.name)

    async def probe(self):
        return HealthReport(
            component=self.name,
            status=HealthStatus.OK,
            checked_at=datetime.now(UTC),
            latency_ms=0,
            detail="ok",
        )


class PlatformAuthTests(unittest.IsolatedAsyncioTestCase):
    async def test_development_can_fail_over_to_experimental_oauth(self):
        api = FakeTransport(
            "openai-api",
            [
                TransportFailure(
                    "openai-api",
                    FailureCategory.AUTHENTICATION,
                    retryable=True,
                )
            ],
        )
        oauth = FakeTransport(
            "codex-oauth-experimental",
            ["fallback"],
            production_allowed=False,
        )
        router = CredentialFailoverRouter(
            [
                TransportRegistration(api, CircuitBreaker()),
                TransportRegistration(oauth, CircuitBreaker()),
            ],
            production=False,
        )

        routed = await router.complete(request())

        self.assertEqual(routed.result.transport, "codex-oauth-experimental")
        self.assertTrue(routed.degraded)

    async def test_production_blocks_experimental_oauth(self):
        oauth = FakeTransport(
            "codex-oauth-experimental",
            ["must not run"],
            production_allowed=False,
        )
        router = CredentialFailoverRouter(
            [TransportRegistration(oauth, CircuitBreaker())],
            production=True,
        )
        with self.assertRaises(TransportFailure):
            await router.complete(request())
        self.assertEqual(oauth.calls, 0)

    async def test_invalid_request_does_not_fail_over(self):
        api = FakeTransport(
            "openai-api",
            [
                TransportFailure(
                    "openai-api",
                    FailureCategory.INVALID_REQUEST,
                    retryable=False,
                )
            ],
        )
        fallback = FakeTransport("backup", ["must not run"])
        router = CredentialFailoverRouter(
            [
                TransportRegistration(api, CircuitBreaker()),
                TransportRegistration(fallback, CircuitBreaker()),
            ],
            production=False,
        )
        with self.assertRaises(TransportFailure):
            await router.complete(request())
        self.assertEqual(fallback.calls, 0)


if __name__ == "__main__":
    unittest.main()
