"""VirtualTeachingAssistant platform core."""

from .domain.models import (
    ActorRole,
    AgentTier,
    Capability,
    DataClassification,
    InteractionMode,
    TeachingRequest,
    TeachingResponse,
)

__all__ = [
    "ActorRole",
    "AgentTier",
    "Capability",
    "DataClassification",
    "InteractionMode",
    "TeachingRequest",
    "TeachingResponse",
]

__version__ = "2.0.0"
