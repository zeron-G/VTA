import unittest

from virtual_teaching_assistant.domain.errors import PolicyDenied
from virtual_teaching_assistant.domain.models import (
    ActionProposal,
    ActorRole,
    ApprovalStatus,
    InteractionMode,
    TeachingRequest,
)
from virtual_teaching_assistant.infrastructure.approvals.memory import (
    InMemoryApprovalStore,
)
from virtual_teaching_assistant.orchestration.actions import SideEffectCoordinator


def request(role):
    return TeachingRequest(
        tenant_id="carey",
        course_id="course-101",
        actor_ref="user:123456789012345678",
        channel="discord",
        role=role,
        mode=InteractionMode.ADMINISTRATION
        if role is not ActorRole.STUDENT
        else InteractionMode.QUESTION_ANSWER,
        content="Propose an update.",
    )


class FakeExecutor:
    action_type = "canvas.grade.write"

    def __init__(self):
        self.calls = []

    async def execute(self, proposal, *, idempotency_key):
        self.calls.append((proposal, idempotency_key))
        return "canvas-operation-1"


class PlatformActionTests(unittest.IsolatedAsyncioTestCase):
    async def test_student_cannot_submit_side_effect(self):
        coordinator = SideEffectCoordinator(InMemoryApprovalStore(), [])
        with self.assertRaises(PolicyDenied):
            await coordinator.submit(
                request(ActorRole.STUDENT),
                ActionProposal("canvas.page.write", "page:1", {}),
            )

    async def test_high_risk_action_requires_two_distinct_approvers(self):
        executor = FakeExecutor()
        coordinator = SideEffectCoordinator(InMemoryApprovalStore(), [executor])
        record = await coordinator.submit(
            request(ActorRole.INSTRUCTOR),
            ActionProposal("canvas.grade.write", "assignment:1", {"value": "proposal"}),
        )
        self.assertEqual(record.required_approvals, 2)
        with self.assertRaises(PolicyDenied):
            await coordinator.execute(record.approval_id)

        record = await coordinator.approve(
            record.approval_id,
            approver_ref="instructor:1",
            approver_role=ActorRole.INSTRUCTOR,
        )
        self.assertEqual(record.status, ApprovalStatus.PENDING)
        record = await coordinator.approve(
            record.approval_id,
            approver_ref="admin:2",
            approver_role=ActorRole.ADMINISTRATOR,
        )
        self.assertEqual(record.status, ApprovalStatus.APPROVED)

        record = await coordinator.execute(record.approval_id)
        self.assertEqual(record.status, ApprovalStatus.EXECUTED)
        self.assertEqual(len(executor.calls), 1)
        same = await coordinator.execute(record.approval_id)
        self.assertEqual(same.execution_ref, "canvas-operation-1")
        self.assertEqual(len(executor.calls), 1)


if __name__ == "__main__":
    unittest.main()
