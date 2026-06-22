import asyncio
import unittest
from datetime import UTC, datetime

from virtual_teaching_assistant.domain.errors import (
    BackendFailure,
    FailureCategory,
    NoBackendAvailable,
)
from virtual_teaching_assistant.domain.models import (
    ActorRole,
    AgentResult,
    AgentTier,
    Capability,
    DataClassification,
    HealthReport,
    HealthStatus,
    InteractionMode,
    TeachingRequest,
)
from virtual_teaching_assistant.orchestration.circuit_breaker import (
    CircuitBreaker,
    CircuitBreakerConfig,
    CircuitState,
)
from virtual_teaching_assistant.orchestration.fallback import (
    BackendRegistration,
    FallbackOrchestrator,
)


def request():
    return TeachingRequest(
        tenant_id="carey",
        course_id="course-101",
        actor_ref="discord:123456789012345678",
        channel="discord",
        role=ActorRole.STUDENT,
        mode=InteractionMode.QUESTION_ANSWER,
        content="What is a network effect?",
    )


class FakeBackend:
    capabilities = frozenset(Capability)
    max_data_classification = DataClassification.INTERNAL

    def __init__(self, name, tier, outcomes):
        self.name = name
        self.tier = tier
        self.outcomes = list(outcomes)
        self.calls = 0
        self.envelopes = []

    async def invoke(self, item, envelope):
        self.calls += 1
        self.envelopes.append(envelope)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        if isinstance(outcome, float):
            await asyncio.sleep(outcome)
            return AgentResult(content="late")
        return AgentResult(content=str(outcome))

    async def probe(self):
        return HealthReport(
            component=self.name,
            status=HealthStatus.OK,
            checked_at=datetime.now(UTC),
            latency_ms=0,
            detail="ok",
        )


class PlatformFallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_ordered_failover_and_permission_monotonicity(self):
        native = FakeBackend(
            "native",
            AgentTier.NATIVE,
            [
                BackendFailure(
                    "native",
                    FailureCategory.AUTHENTICATION,
                    retryable=True,
                )
            ],
        )
        codex = FakeBackend("codex-cli", AgentTier.CODEX, ["safe answer"])
        router = FallbackOrchestrator(
            [
                BackendRegistration(codex, CircuitBreaker()),
                BackendRegistration(native, CircuitBreaker()),
            ]
        )

        response = await router.execute(request())

        self.assertEqual(response.backend, "codex-cli")
        self.assertTrue(response.degraded)
        self.assertEqual([item.backend for item in response.attempts], ["native", "codex-cli"])
        self.assertFalse(codex.envelopes[0].side_effects_allowed)
        self.assertNotIn(Capability.CANVAS_WRITE, codex.envelopes[0].capabilities)

    async def test_fatal_failure_does_not_try_lower_backend(self):
        native = FakeBackend(
            "native",
            AgentTier.NATIVE,
            [
                BackendFailure(
                    "native",
                    FailureCategory.INVALID_REQUEST,
                    retryable=False,
                )
            ],
        )
        fallback = FakeBackend("codex-cli", AgentTier.CODEX, ["must not run"])
        router = FallbackOrchestrator(
            [
                BackendRegistration(native, CircuitBreaker()),
                BackendRegistration(fallback, CircuitBreaker()),
            ]
        )

        with self.assertRaises(BackendFailure):
            await router.execute(request())
        self.assertEqual(fallback.calls, 0)

    async def test_timeout_fails_over(self):
        slow = FakeBackend("native", AgentTier.NATIVE, [0.05])
        fast = FakeBackend("codex-cli", AgentTier.CODEX, ["fallback"])
        router = FallbackOrchestrator(
            [
                BackendRegistration(slow, CircuitBreaker(), timeout_seconds=0.001),
                BackendRegistration(fast, CircuitBreaker()),
            ]
        )

        response = await router.execute(request())

        self.assertEqual(response.backend, "codex-cli")
        self.assertEqual(response.attempts[0].failure_category, "timeout")

    async def test_no_eligible_backend_raises(self):
        backend = FakeBackend("native", AgentTier.NATIVE, ["unused"])
        router = FallbackOrchestrator(
            [BackendRegistration(backend, CircuitBreaker(), enabled=False)]
        )
        with self.assertRaises(NoBackendAvailable):
            await router.execute(request())

    def test_circuit_opens_and_recovers_half_open(self):
        now = [100.0]
        breaker = CircuitBreaker(
            CircuitBreakerConfig(failure_threshold=2, recovery_timeout_seconds=10),
            clock=lambda: now[0],
        )
        self.assertTrue(breaker.allow_request())
        breaker.record_failure()
        self.assertTrue(breaker.allow_request())
        breaker.record_failure()
        self.assertEqual(breaker.snapshot().state, CircuitState.OPEN)
        self.assertFalse(breaker.allow_request())
        now[0] += 11
        self.assertTrue(breaker.allow_request())
        self.assertEqual(breaker.snapshot().state, CircuitState.HALF_OPEN)
        self.assertFalse(breaker.allow_request())
        breaker.record_success()
        self.assertEqual(breaker.snapshot().state, CircuitState.CLOSED)


if __name__ == "__main__":
    unittest.main()
