"""Strict environment configuration for the VTA platform control plane."""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Mapping

from ..domain.errors import ConfigurationError


class DeploymentStage(str, Enum):
    DEVELOPMENT = "development"
    PILOT = "pilot"
    PRODUCTION = "production"


class SecretValue:
    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def get_secret_value(self) -> str:
        return self._value

    def __repr__(self) -> str:
        return "SecretValue('<redacted>')"

    __str__ = __repr__


def _bool(value: str, name: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ConfigurationError(f"{name} must be true or false.")


def _positive_float(value: str, name: str) -> float:
    try:
        parsed = float(value)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be a number.") from exc
    if parsed <= 0:
        raise ConfigurationError(f"{name} must be positive.")
    return parsed


def _positive_int(value: str, name: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be an integer.") from exc
    if parsed <= 0:
        raise ConfigurationError(f"{name} must be positive.")
    return parsed


@dataclass(frozen=True, slots=True)
class PlatformConfig:
    stage: DeploymentStage
    tenant_id: str
    agent_order: tuple[str, ...]
    agent_timeout_seconds: float
    circuit_failure_threshold: int
    circuit_recovery_seconds: float
    enable_native: bool
    enable_codex_cli: bool
    codex_isolated: bool
    codex_working_directory: Path
    enable_openclaw: bool
    openclaw_isolated: bool
    allow_experimental_oauth: bool
    audit_hmac_key: SecretValue
    model: str

    @property
    def production(self) -> bool:
        return self.stage is DeploymentStage.PRODUCTION

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> "PlatformConfig":
        values = environ if environ is not None else os.environ
        stage = DeploymentStage(values.get("VTA_STAGE", "development").strip().lower())
        order = tuple(
            item.strip().lower()
            for item in values.get(
                "VTA_AGENT_ORDER",
                "native,codex-cli,openclaw",
            ).split(",")
            if item.strip()
        )
        supported = {"native", "codex-cli", "openclaw"}
        if not order or len(set(order)) != len(order) or set(order) - supported:
            raise ConfigurationError("VTA_AGENT_ORDER is invalid or contains duplicates.")

        audit_value = values.get("VTA_AUDIT_HMAC_KEY", "")
        if not audit_value and stage is not DeploymentStage.PRODUCTION:
            audit_value = "development-only-audit-key-not-for-production"

        config = cls(
            stage=stage,
            tenant_id=values.get("VTA_TENANT_ID", "carey").strip(),
            agent_order=order,
            agent_timeout_seconds=_positive_float(
                values.get("VTA_AGENT_TIMEOUT_SECONDS", "45"),
                "VTA_AGENT_TIMEOUT_SECONDS",
            ),
            circuit_failure_threshold=_positive_int(
                values.get("VTA_CIRCUIT_FAILURE_THRESHOLD", "3"),
                "VTA_CIRCUIT_FAILURE_THRESHOLD",
            ),
            circuit_recovery_seconds=_positive_float(
                values.get("VTA_CIRCUIT_RECOVERY_SECONDS", "30"),
                "VTA_CIRCUIT_RECOVERY_SECONDS",
            ),
            enable_native=_bool(
                values.get("VTA_ENABLE_NATIVE", "true"),
                "VTA_ENABLE_NATIVE",
            ),
            enable_codex_cli=_bool(
                values.get("VTA_ENABLE_CODEX_CLI", "false"),
                "VTA_ENABLE_CODEX_CLI",
            ),
            codex_isolated=_bool(
                values.get("VTA_CODEX_ISOLATED", "false"),
                "VTA_CODEX_ISOLATED",
            ),
            codex_working_directory=Path(
                values.get("VTA_CODEX_WORKING_DIRECTORY", ".")
            ).expanduser().resolve(),
            enable_openclaw=_bool(
                values.get("VTA_ENABLE_OPENCLAW", "false"),
                "VTA_ENABLE_OPENCLAW",
            ),
            openclaw_isolated=_bool(
                values.get("VTA_OPENCLAW_ISOLATED", "false"),
                "VTA_OPENCLAW_ISOLATED",
            ),
            allow_experimental_oauth=_bool(
                values.get("VTA_ALLOW_EXPERIMENTAL_OAUTH", "false"),
                "VTA_ALLOW_EXPERIMENTAL_OAUTH",
            ),
            audit_hmac_key=SecretValue(audit_value),
            model=values.get("VTA_MODEL", "gpt-5.5").strip(),
        )
        config.validate()
        return config

    def validate(self) -> None:
        if not self.tenant_id or len(self.tenant_id) > 64:
            raise ConfigurationError("VTA_TENANT_ID is invalid.")
        if not self.model:
            raise ConfigurationError("VTA_MODEL may not be empty.")
        enabled = {
            "native": self.enable_native,
            "codex-cli": self.enable_codex_cli,
            "openclaw": self.enable_openclaw,
        }
        if not any(enabled[name] for name in self.agent_order):
            raise ConfigurationError("At least one ordered agent backend must be enabled.")
        if self.production:
            if len(self.audit_hmac_key.get_secret_value()) < 32:
                raise ConfigurationError(
                    "Production requires VTA_AUDIT_HMAC_KEY with at least 32 characters."
                )
            if self.allow_experimental_oauth:
                raise ConfigurationError(
                    "Experimental personal OAuth is forbidden in production."
                )
            if self.enable_codex_cli and not self.codex_isolated:
                raise ConfigurationError(
                    "Production Codex CLI requires VTA_CODEX_ISOLATED=true."
                )
            if self.enable_openclaw and not self.openclaw_isolated:
                raise ConfigurationError(
                    "Production OpenClaw requires VTA_OPENCLAW_ISOLATED=true."
                )

    def redacted(self) -> dict[str, object]:
        return {
            "stage": self.stage.value,
            "tenant_id": self.tenant_id,
            "agent_order": self.agent_order,
            "agent_timeout_seconds": self.agent_timeout_seconds,
            "circuit_failure_threshold": self.circuit_failure_threshold,
            "circuit_recovery_seconds": self.circuit_recovery_seconds,
            "enable_native": self.enable_native,
            "enable_codex_cli": self.enable_codex_cli,
            "codex_isolated": self.codex_isolated,
            "codex_working_directory": str(self.codex_working_directory),
            "enable_openclaw": self.enable_openclaw,
            "openclaw_isolated": self.openclaw_isolated,
            "allow_experimental_oauth": self.allow_experimental_oauth,
            "audit_hmac_key": "<set>",
            "model": self.model,
        }
