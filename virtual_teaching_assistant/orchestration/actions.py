"""Approval-gated side-effect coordination."""

from __future__ import annotations

import uuid
from dataclasses import replace
from typing import Iterable

from ..domain.errors import PolicyDenied
from ..domain.models import (
    ActionProposal,
    ActorRole,
    ApprovalRecord,
    ApprovalStatus,
    TeachingRequest,
)
from ..ports.actions import ActionExecutor, ApprovalStore


_HIGH_RISK_ACTIONS = frozenset(
    {
        "canvas.grade.write",
        "canvas.enrollment.write",
        "canvas.assessment.publish",
        "channel.bulk-send",
    }
)


class SideEffectCoordinator:
    def __init__(
        self,
        store: ApprovalStore,
        executors: Iterable[ActionExecutor],
    ) -> None:
        self._store = store
        self._executors = {executor.action_type: executor for executor in executors}

    async def submit(
        self,
        request: TeachingRequest,
        proposal: ActionProposal,
    ) -> ApprovalRecord:
        if request.role not in {
            ActorRole.COURSE_STAFF,
            ActorRole.INSTRUCTOR,
            ActorRole.ADMINISTRATOR,
            ActorRole.SERVICE,
        }:
            raise PolicyDenied("Students cannot submit side-effect proposals.")
        required = 2 if proposal.action_type in _HIGH_RISK_ACTIONS else 1
        return await self._store.create(
            ApprovalRecord(
                approval_id=str(uuid.uuid4()),
                tenant_id=request.tenant_id,
                course_id=request.course_id,
                request_id=request.request_id,
                requested_by=request.actor_ref,
                proposal=proposal,
                required_approvals=required,
            )
        )

    async def approve(
        self,
        approval_id: str,
        *,
        approver_ref: str,
        approver_role: ActorRole,
    ) -> ApprovalRecord:
        if approver_role not in {ActorRole.INSTRUCTOR, ActorRole.ADMINISTRATOR}:
            raise PolicyDenied("Approval requires an instructor or administrator.")
        record = await self._store.get(approval_id)
        if record.status not in {ApprovalStatus.PENDING, ApprovalStatus.APPROVED}:
            raise PolicyDenied("Approval is no longer pending.")
        approvers = record.approvers
        if approver_ref not in approvers:
            approvers = (*approvers, approver_ref)
        status = (
            ApprovalStatus.APPROVED
            if len(approvers) >= record.required_approvals
            else ApprovalStatus.PENDING
        )
        return await self._store.update(
            replace(record, approvers=approvers, status=status)
        )

    async def reject(
        self,
        approval_id: str,
        *,
        approver_role: ActorRole,
    ) -> ApprovalRecord:
        if approver_role not in {ActorRole.INSTRUCTOR, ActorRole.ADMINISTRATOR}:
            raise PolicyDenied("Rejection requires an instructor or administrator.")
        record = await self._store.get(approval_id)
        if record.status is not ApprovalStatus.PENDING:
            raise PolicyDenied("Approval is no longer pending.")
        return await self._store.update(replace(record, status=ApprovalStatus.REJECTED))

    async def execute(self, approval_id: str) -> ApprovalRecord:
        record = await self._store.get(approval_id)
        if record.status is ApprovalStatus.EXECUTED:
            return record
        if record.status is not ApprovalStatus.APPROVED:
            raise PolicyDenied("Side effect has not received required approvals.")
        try:
            executor = self._executors[record.proposal.action_type]
        except KeyError as exc:
            raise PolicyDenied("No executor is registered for this action type.") from exc
        execution_ref = await executor.execute(
            record.proposal,
            idempotency_key=record.approval_id,
        )
        return await self._store.update(
            replace(
                record,
                status=ApprovalStatus.EXECUTED,
                execution_ref=execution_ref,
            )
        )
