import json
import unittest

from virtual_teaching_assistant.domain.models import (
    ActorRole,
    AgentResult,
    AgentTier,
    Capability,
    DataClassification,
    InteractionMode,
    TeachingRequest,
)
from virtual_teaching_assistant.infrastructure.observability.audit import InMemoryAuditSink
from virtual_teaching_assistant.orchestration.circuit_breaker import CircuitBreaker
from virtual_teaching_assistant.orchestration.fallback import (
    BackendRegistration,
    FallbackOrchestrator,
)
from virtual_teaching_assistant.orchestration.service import TeachingService


class Backend:
    name = "native"
    tier = AgentTier.NATIVE
    capabilities = frozenset(Capability)
    max_data_classification = DataClassification.INTERNAL

    async def invoke(self, request, envelope):
        return AgentResult(content="A network effect grows with participation.")


class PlatformServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_audit_never_contains_raw_prompt_or_actor_reference(self):
        prompt = "private student question 8f9f80"
        actor = "discord:991122334455667788"
        request = TeachingRequest(
            tenant_id="carey",
            course_id="course-101",
            actor_ref=actor,
            channel="discord",
            role=ActorRole.STUDENT,
            mode=InteractionMode.QUESTION_ANSWER,
            content=prompt,
        )
        sink = InMemoryAuditSink()
        service = TeachingService(
            FallbackOrchestrator(
                [BackendRegistration(Backend(), CircuitBreaker())]
            ),
            sink,
            audit_hmac_key=b"a" * 32,
        )

        await service.handle(request)

        serialized = json.dumps(sink.events)
        self.assertNotIn(prompt, serialized)
        self.assertNotIn(actor, serialized)
        self.assertEqual(sink.events[0]["details"]["input_chars"], len(prompt))
        self.assertEqual(len(sink.events[0]["actor_digest"]), 64)


if __name__ == "__main__":
    unittest.main()
