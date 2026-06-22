"""In-memory approval store for tests and single-process pilots."""

from __future__ import annotations

import asyncio

from ...domain.models import ApprovalRecord


class InMemoryApprovalStore:
    def __init__(self) -> None:
        self._records: dict[str, ApprovalRecord] = {}
        self._lock = asyncio.Lock()

    async def create(self, record: ApprovalRecord) -> ApprovalRecord:
        async with self._lock:
            if record.approval_id in self._records:
                raise ValueError("Approval id already exists")
            self._records[record.approval_id] = record
            return record

    async def get(self, approval_id: str) -> ApprovalRecord:
        async with self._lock:
            return self._records[approval_id]

    async def update(self, record: ApprovalRecord) -> ApprovalRecord:
        async with self._lock:
            if record.approval_id not in self._records:
                raise KeyError(record.approval_id)
            self._records[record.approval_id] = record
            return record
