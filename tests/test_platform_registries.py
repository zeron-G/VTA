import unittest
from pathlib import Path

from virtual_teaching_assistant.activities.registry import (
    ActivityDescriptor,
    ActivityRegistry,
)
from virtual_teaching_assistant.domain.models import (
    ActorRole,
    AgentTier,
    Capability,
    InteractionMode,
    TeachingResponse,
)
from virtual_teaching_assistant.infrastructure.channels.registry import ChannelRegistry
from virtual_teaching_assistant.skills.registry import SkillRegistry


class FakeActivity:
    activity_id = "class-debate"
    modes = frozenset({InteractionMode.ACTIVITY})
    required_capabilities = frozenset({Capability.ACTIVITY_MANAGE})

    async def start(self, request):
        return {"state": "started"}

    async def handle(self, request, state):
        return state

    async def stop(self, state):
        return {"state": "stopped"}


class FakeChannel:
    name = "carey-app"

    async def normalize(self, payload):
        return payload

    async def deliver(self, response, destination):
        return destination

    async def probe(self):
        raise NotImplementedError


class PlatformRegistryTests(unittest.TestCase):
    def test_bundled_course_skill_manifest_is_discoverable(self):
        root = Path(__file__).resolve().parents[1] / "course_ta_deployer" / "skills"
        registry = SkillRegistry()
        discovered = registry.discover(root)
        self.assertEqual([item.skill_id for item in discovered], ["course-ta"])
        self.assertIn(InteractionMode.QUESTION_ANSWER, discovered[0].modes)

    def test_future_channel_registers_without_orchestrator_change(self):
        registry = ChannelRegistry()
        registry.register(FakeChannel())
        self.assertEqual(registry.names, ("carey-app",))

    def test_activity_contract_must_match_plugin(self):
        descriptor = ActivityDescriptor(
            activity_id="class-debate",
            display_name="Class Debate",
            modes=frozenset({InteractionMode.ACTIVITY}),
            required_role=ActorRole.INSTRUCTOR,
            required_capabilities=frozenset({Capability.ACTIVITY_MANAGE}),
        )
        registry = ActivityRegistry()
        registry.register(descriptor, FakeActivity())
        self.assertEqual(registry.descriptors, (descriptor,))


if __name__ == "__main__":
    unittest.main()
