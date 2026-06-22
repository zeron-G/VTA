import json
import tempfile
import unittest
from pathlib import Path

from virtual_teaching_assistant.domain.models import (
    ActorRole,
    Capability,
    CapabilityEnvelope,
    DataClassification,
    InteractionMode,
    TeachingRequest,
)
from virtual_teaching_assistant.infrastructure.agents.codex_cli import CodexCliBackend
from virtual_teaching_assistant.infrastructure.agents.process import (
    ProcessResult,
    minimal_environment,
)
from virtual_teaching_assistant.infrastructure.auth.transports import (
    CodexOAuthTransport,
    OpenAIResponsesTransport,
)
from virtual_teaching_assistant.ports.llm import LLMRequest


class FakeExecutor:
    def __init__(self, result):
        self.result = result
        self.calls = []

    async def run(self, command, **kwargs):
        self.calls.append((tuple(command), kwargs))
        return ProcessResult(tuple(command), *self.result)


class FakeUsage:
    input_tokens = 4
    output_tokens = 2
    total_tokens = 6


class FakeResponse:
    output_text = "answer"
    model = "gpt-5.5"
    usage = FakeUsage()


class FakeResponses:
    def __init__(self):
        self.kwargs = None

    async def create(self, **kwargs):
        self.kwargs = kwargs
        return FakeResponse()


class FakeOpenAIClient:
    def __init__(self):
        self.responses = FakeResponses()


class FakeOAuthResponse:
    content = "oauth answer"
    model = "gpt-5.5"
    usage = FakeUsage()


class FakeOAuthClient:
    async def complete(self, **kwargs):
        return FakeOAuthResponse()


class PlatformAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_codex_uses_stdin_and_restricted_flags(self):
        event = {
            "type": "item.completed",
            "item": {"type": "agent_message", "text": "student-facing answer"},
        }
        executor = FakeExecutor((0, json.dumps(event), ""))
        with tempfile.TemporaryDirectory() as td:
            backend = CodexCliBackend(
                working_directory=Path(td),
                executor=executor,
            )
            item = TeachingRequest(
                tenant_id="carey",
                course_id="course-101",
                actor_ref="discord:123456789012345678",
                channel="discord",
                role=ActorRole.STUDENT,
                mode=InteractionMode.QUESTION_ANSWER,
                content="private student question",
            )
            envelope = CapabilityEnvelope(
                frozenset({Capability.REASON, Capability.COURSE_READ}),
                DataClassification.INTERNAL,
            )
            result = await backend.invoke(item, envelope)

        command, kwargs = executor.calls[0]
        rendered = " ".join(command)
        self.assertEqual(result.content, "student-facing answer")
        self.assertIn("--ephemeral", command)
        self.assertIn("read-only", command)
        self.assertIn("--ask-for-approval", command)
        self.assertIn("never", command)
        self.assertIn("--ignore-user-config", command)
        self.assertNotIn("private student question", rendered)
        self.assertIn("private student question", kwargs["stdin_text"])
        self.assertNotIn("--yolo", command)
        self.assertNotIn("danger-full-access", command)

    def test_process_environment_rejects_unrelated_secret(self):
        with self.assertRaises(ValueError):
            minimal_environment({"DATABASE_PASSWORD": "not-forwarded"})

    async def test_official_transport_uses_store_false(self):
        client = FakeOpenAIClient()
        transport = OpenAIResponsesTransport(client=client)
        result = await transport.complete(
            LLMRequest(
                input="question",
                instructions="policy",
                model="gpt-5.5",
                data_classification=DataClassification.INTERNAL,
                request_id="request-1",
                trace_id="trace-1",
            )
        )
        self.assertEqual(result.content, "answer")
        self.assertFalse(client.responses.kwargs["store"])

    async def test_oauth_transport_is_marked_non_production(self):
        transport = CodexOAuthTransport(client=FakeOAuthClient())
        self.assertFalse(transport.production_allowed)


if __name__ == "__main__":
    unittest.main()
