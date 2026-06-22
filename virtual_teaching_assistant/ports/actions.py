"""Approval storage and side-effect executor ports."""

from __future__ import annotations

from typing import Protocol

from ..domain.models import ActionProposal, ApprovalRecord


class ApprovalStore(Protocol):
    async def create(self, record: ApprovalRecord) -> ApprovalRecord: ...

    async def get(self, approval_id: str) -> ApprovalRecord: ...

    async def update(self, record: ApprovalRecord) -> ApprovalRecord: ...


class ActionExecutor(Protocol):
    action_type: str

    async def execute(
        self,
        proposal: ActionProposal,
        *,
        idempotency_key: str,
    ) -> str: ...
