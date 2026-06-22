"""Immutable platform records shared by all adapters."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum, IntEnum
from types import MappingProxyType
from typing import Any, Mapping

from .errors import ConfigurationError


_REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$")


class ActorRole(str, Enum):
    STUDENT = "student"
    COURSE_STAFF = "course_staff"
    INSTRUCTOR = "instructor"
    ADMINISTRATOR = "administrator"
    SERVICE = "service"


class InteractionMode(str, Enum):
    QUESTION_ANSWER = "question_answer"
    LIVE_CLASS = "live_class"
    POST_CLASS_RECAP = "post_class_recap"
    ACTIVITY = "activity"
    ADMINISTRATION = "administration"


class DataClassification(IntEnum):
    PUBLIC = 0
    INTERNAL = 1
    RESTRICTED = 2
    HIGHLY_RESTRICTED = 3


class AgentTier(IntEnum):
    NATIVE = 1
    CODEX = 2
    OPENCLAW = 3


class Capability(str, Enum):
    REASON = "reason"
    COURSE_READ = "course.read"
    CANVAS_READ = "canvas.read"
    RESPONSE_DRAFT = "response.draft"
    LIVE_ANALYZE = "live.analyze"
    RECAP_DRAFT = "recap.draft"
    ACTIVITY_PARTICIPATE = "activity.participate"
    ACTIVITY_MANAGE = "activity.manage"
    DISCORD_SEND = "discord.send"
    CANVAS_WRITE = "canvas.write"
    CONFIG_WRITE = "config.write"


class HealthStatus(str, Enum):
    OK = "ok"
    DEGRADED = "degraded"
    FAILED = "failed"
    DISABLED = "disabled"


class ApprovalStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXECUTED = "executed"


@dataclass(frozen=True, slots=True)
class CapabilityEnvelope:
    capabilities: frozenset[Capability]
    max_data_classification: DataClassification
    side_effects_allowed: bool = False

    def restrict(
        self,
        capabilities: frozenset[Capability],
        max_data_classification: DataClassification,
        *,
        allow_side_effects: bool = False,
    ) -> "CapabilityEnvelope":
        return CapabilityEnvelope(
            capabilities=self.capabilities & capabilities,
            max_data_classification=min(
                self.max_data_classification,
                max_data_classification,
            ),
            side_effects_allowed=self.side_effects_allowed and allow_side_effects,
        )


@dataclass(frozen=True, slots=True)
class TeachingRequest:
    tenant_id: str
    course_id: str
    actor_ref: str
    channel: str
    role: ActorRole
    mode: InteractionMode
    content: str
    data_classification: DataClassification = DataClassification.INTERNAL
    request_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    trace_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    idempotency_key: str = field(default_factory=lambda: str(uuid.uuid4()))
    occurred_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    metadata: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for name in (
            "tenant_id",
            "course_id",
            "actor_ref",
            "channel",
            "request_id",
            "trace_id",
            "idempotency_key",
        ):
            value = str(getattr(self, name))
            if not _REF_RE.fullmatch(value):
                raise ConfigurationError(f"{name} has an invalid format.")
        if not self.content.strip():
            raise ConfigurationError("Request content may not be empty.")
        if len(self.content) > 32_768:
            raise ConfigurationError("Request content exceeds the 32768 character limit.")
        if self.occurred_at.tzinfo is None:
            raise ConfigurationError("occurred_at must include a timezone.")
        copied = {str(key): str(value) for key, value in self.metadata.items()}
        if len(copied) > 32 or any(len(key) > 64 or len(value) > 512 for key, value in copied.items()):
            raise ConfigurationError("Request metadata exceeds platform limits.")
        object.__setattr__(self, "metadata", MappingProxyType(copied))


@dataclass(frozen=True, slots=True)
class ActionProposal:
    action_type: str
    target_ref: str
    arguments: Mapping[str, Any] = field(default_factory=dict)
    requires_approval: bool = True

    def __post_init__(self) -> None:
        if not _REF_RE.fullmatch(self.action_type) or not _REF_RE.fullmatch(self.target_ref):
            raise ConfigurationError("Action proposal identifiers are invalid.")
        object.__setattr__(self, "arguments", MappingProxyType(dict(self.arguments)))


@dataclass(frozen=True, slots=True)
class ApprovalRecord:
    approval_id: str
    tenant_id: str
    course_id: str
    request_id: str
    requested_by: str
    proposal: ActionProposal
    required_approvals: int
    status: ApprovalStatus = ApprovalStatus.PENDING
    approvers: tuple[str, ...] = ()
    execution_ref: str | None = None

    def __post_init__(self) -> None:
        if self.required_approvals <= 0:
            raise ConfigurationError("required_approvals must be positive.")


@dataclass(frozen=True, slots=True)
class AgentResult:
    content: str
    citations: tuple[str, ...] = ()
    proposed_actions: tuple[ActionProposal, ...] = ()
    model: str | None = None
    usage: Mapping[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.content.strip():
            raise ConfigurationError("Agent result content may not be empty.")
        if len(self.content) > 64_000:
            raise ConfigurationError("Agent result exceeds the platform limit.")
        object.__setattr__(self, "usage", MappingProxyType(dict(self.usage)))


@dataclass(frozen=True, slots=True)
class AgentAttempt:
    backend: str
    tier: AgentTier
    outcome: str
    duration_ms: int
    failure_category: str | None = None


@dataclass(frozen=True, slots=True)
class TeachingResponse:
    request_id: str
    trace_id: str
    content: str
    backend: str
    tier: AgentTier
    degraded: bool
    attempts: tuple[AgentAttempt, ...]
    citations: tuple[str, ...] = ()
    proposed_actions: tuple[ActionProposal, ...] = ()
    model: str | None = None


@dataclass(frozen=True, slots=True)
class HealthReport:
    component: str
    status: HealthStatus
    checked_at: datetime
    latency_ms: int
    detail: str
    critical: bool = True
    metadata: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "metadata",
            MappingProxyType({str(k): str(v) for k, v in self.metadata.items()}),
        )
