import unittest

from virtual_teaching_assistant.domain.errors import ConfigurationError, PolicyDenied
from virtual_teaching_assistant.domain.models import (
    ActorRole,
    Capability,
    DataClassification,
    InteractionMode,
    TeachingRequest,
)
from virtual_teaching_assistant.orchestration.policy import PolicyEngine


def request(**overrides):
    values = {
        "tenant_id": "carey",
        "course_id": "course-101",
        "actor_ref": "discord:123456789012345678",
        "channel": "discord",
        "role": ActorRole.STUDENT,
        "mode": InteractionMode.QUESTION_ANSWER,
        "content": "Explain opportunity cost.",
    }
    values.update(overrides)
    return TeachingRequest(**values)


class PlatformDomainTests(unittest.TestCase):
    def test_request_is_validated_and_metadata_is_immutable(self):
        item = request(metadata={"source": "test"})
        self.assertEqual(item.metadata["source"], "test")
        with self.assertRaises(TypeError):
            item.metadata["source"] = "changed"
        with self.assertRaises(ConfigurationError):
            request(course_id="../../other-course")

    def test_policy_never_grants_side_effects_to_agent(self):
        decision = PolicyEngine().evaluate(
            request(role=ActorRole.INSTRUCTOR),
            frozenset(
                {
                    Capability.REASON,
                    Capability.CANVAS_READ,
                    Capability.CANVAS_WRITE,
                    Capability.DISCORD_SEND,
                }
            ),
        )
        self.assertIn(Capability.REASON, decision.envelope.capabilities)
        self.assertIn(Capability.CANVAS_READ, decision.envelope.capabilities)
        self.assertNotIn(Capability.CANVAS_WRITE, decision.envelope.capabilities)
        self.assertNotIn(Capability.DISCORD_SEND, decision.envelope.capabilities)
        self.assertFalse(decision.envelope.side_effects_allowed)

    def test_student_cannot_request_administration(self):
        with self.assertRaises(PolicyDenied):
            PolicyEngine().evaluate(
                request(mode=InteractionMode.ADMINISTRATION),
            )

    def test_highly_restricted_data_never_enters_agent(self):
        with self.assertRaises(PolicyDenied):
            PolicyEngine().evaluate(
                request(
                    role=ActorRole.INSTRUCTOR,
                    data_classification=DataClassification.HIGHLY_RESTRICTED,
                )
            )


if __name__ == "__main__":
    unittest.main()
