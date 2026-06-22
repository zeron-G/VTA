"""Role, mode, and data-classification policy."""

from __future__ import annotations

from dataclasses import dataclass

from ..domain.errors import PolicyDenied
from ..domain.models import (
    ActorRole,
    Capability,
    CapabilityEnvelope,
    DataClassification,
    InteractionMode,
    TeachingRequest,
)


_SIDE_EFFECT_CAPABILITIES = frozenset(
    {Capability.DISCORD_SEND, Capability.CANVAS_WRITE, Capability.CONFIG_WRITE}
)

_ROLE_CAPABILITIES: dict[ActorRole, frozenset[Capability]] = {
    ActorRole.STUDENT: frozenset(
        {
            Capability.REASON,
            Capability.COURSE_READ,
            Capability.CANVAS_READ,
            Capability.RESPONSE_DRAFT,
            Capability.ACTIVITY_PARTICIPATE,
        }
    ),
    ActorRole.COURSE_STAFF: frozenset(
        {
            Capability.REASON,
            Capability.COURSE_READ,
            Capability.CANVAS_READ,
            Capability.RESPONSE_DRAFT,
            Capability.LIVE_ANALYZE,
            Capability.RECAP_DRAFT,
            Capability.ACTIVITY_PARTICIPATE,
            Capability.ACTIVITY_MANAGE,
            Capability.DISCORD_SEND,
        }
    ),
    ActorRole.INSTRUCTOR: frozenset(Capability),
    ActorRole.ADMINISTRATOR: frozenset(Capability),
    ActorRole.SERVICE: frozenset(
        {
            Capability.REASON,
            Capability.COURSE_READ,
            Capability.CANVAS_READ,
            Capability.RESPONSE_DRAFT,
            Capability.LIVE_ANALYZE,
            Capability.RECAP_DRAFT,
        }
    ),
}

_MODE_CAPABILITIES: dict[InteractionMode, frozenset[Capability]] = {
    InteractionMode.QUESTION_ANSWER: frozenset(
        {
            Capability.REASON,
            Capability.COURSE_READ,
            Capability.CANVAS_READ,
            Capability.RESPONSE_DRAFT,
        }
    ),
    InteractionMode.LIVE_CLASS: frozenset(
        {Capability.REASON, Capability.COURSE_READ, Capability.LIVE_ANALYZE}
    ),
    InteractionMode.POST_CLASS_RECAP: frozenset(
        {Capability.REASON, Capability.COURSE_READ, Capability.RECAP_DRAFT}
    ),
    InteractionMode.ACTIVITY: frozenset(
        {
            Capability.REASON,
            Capability.COURSE_READ,
            Capability.ACTIVITY_PARTICIPATE,
        }
    ),
    InteractionMode.ADMINISTRATION: frozenset(
        {Capability.REASON, Capability.COURSE_READ, Capability.CANVAS_READ}
    ),
}


@dataclass(frozen=True, slots=True)
class PolicyDecision:
    envelope: CapabilityEnvelope
    policy_version: str
    reason: str


class PolicyEngine:
    """Compute immutable agent capabilities; never authorize side effects."""

    version = "2026-06-22.1"

    def evaluate(
        self,
        request: TeachingRequest,
        requested_capabilities: frozenset[Capability] | None = None,
    ) -> PolicyDecision:
        if request.data_classification is DataClassification.HIGHLY_RESTRICTED:
            raise PolicyDenied("Highly restricted data may not enter an agent request.")
        if (
            request.data_classification is DataClassification.RESTRICTED
            and request.role is ActorRole.STUDENT
        ):
            raise PolicyDenied("Student-originated restricted data requires staff review.")
        if request.mode is InteractionMode.ADMINISTRATION and request.role not in {
            ActorRole.INSTRUCTOR,
            ActorRole.ADMINISTRATOR,
        }:
            raise PolicyDenied("Administrative requests require an instructor role.")

        role_caps = _ROLE_CAPABILITIES[request.role]
        mode_caps = _MODE_CAPABILITIES[request.mode]
        desired = requested_capabilities or mode_caps
        unauthorized = desired - role_caps
        if unauthorized:
            raise PolicyDenied("Requested capabilities exceed the actor role.")

        reasoning_caps = (desired & role_caps) - _SIDE_EFFECT_CAPABILITIES
        max_classification = (
            DataClassification.RESTRICTED
            if request.role in {ActorRole.INSTRUCTOR, ActorRole.ADMINISTRATOR}
            else DataClassification.INTERNAL
        )
        envelope = CapabilityEnvelope(
            capabilities=frozenset(reasoning_caps),
            max_data_classification=max_classification,
            side_effects_allowed=False,
        )
        return PolicyDecision(
            envelope=envelope,
            policy_version=self.version,
            reason="reasoning-only capability envelope",
        )
