"""Pure configuration builders used by deployment and tests."""

from __future__ import annotations

import copy
import secrets
from pathlib import Path

from .config import DeploymentConfig


def merge_dict(base: dict, patch: dict) -> dict:
    result = copy.deepcopy(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge_dict(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def openclaw_config(config: DeploymentConfig, existing: dict | None = None) -> dict:
    gateway_token = config.gateway_token
    if not gateway_token and existing:
        gateway_token = (((existing.get("gateway") or {}).get("auth") or {}).get("token")) or ""
    gateway_token = gateway_token or secrets.token_hex(24)

    channel_rules = {
        channel: {"requireMention": config.require_mention, "users": []}
        for channel in config.discord_channels
    }
    channel_rules.update({channel: {"enabled": False} for channel in config.discord_blocked_channels})

    generated = {
        "agents": {
            "defaults": {
                "workspace": str(config.workspace_dir),
                "model": {"primary": config.model, "fallbacks": []},
                "compaction": {"mode": "safeguard"},
            }
        },
        "gateway": {
            "mode": "local",
            "port": config.gateway_port,
            "bind": "loopback",
            "auth": {"mode": "token", "token": gateway_token},
        },
        "tools": {
            "allow": [
                "group:fs",
                "group:runtime",
                "group:sessions",
                "group:messaging",
                "memory_search",
                "memory_get",
                "image",
            ]
        },
        "commands": {"native": "auto", "nativeSkills": "auto", "restart": True},
        "plugins": {
            "allow": ["discord", "memory-core", "openai"],
            "entries": {"discord": {"enabled": True}, "openai": {"enabled": True}},
        },
        "channels": {
            "discord": {
                "enabled": True,
                "token": config.discord_bot_token,
                "allowBots": False,
                "groupPolicy": "allowlist",
                "streaming": {"mode": "partial"},
                "replyToMode": "off",
                "guilds": {
                    config.discord_guild_id: {
                        "requireMention": config.require_mention,
                        "channels": channel_rules,
                    }
                },
                "threadBindings": {
                    "enabled": True,
                    "spawnSubagentSessions": False,
                    "idleHours": 72,
                    "maxAgeHours": 0,
                },
                "name": "Discord",
            }
        },
    }
    result = merge_dict(existing or {}, generated)
    # The generated guild channel map is authoritative. Deep-merging here would
    # preserve a pre-existing wildcard and silently widen the security boundary.
    result["channels"]["discord"]["guilds"][config.discord_guild_id]["channels"] = channel_rules
    return result


def course_ta_config(config: DeploymentConfig) -> dict:
    allowed = [f"channel:{channel}" for channel in config.discord_channels]
    blocked = [f"channel:{channel}" for channel in config.discord_blocked_channels]
    mapping = {
        f"channel:{channel}": {
            "canvas_id": config.canvas_course_id,
            "slug": config.course_slug,
            "section": config.course_section,
        }
        for channel in config.discord_channels
    }
    return {
        "canvas_id": config.canvas_course_id,
        "slug": config.course_slug,
        "course_name": config.course_name,
        "course_section": config.course_section,
        "professor_name": config.professor_name,
        "semester": config.semester,
        "allowed_channels": allowed,
        "blocked_channels": blocked,
        "channel_course_map": mapping,
        "admin_users": config.admin_users,
        "privileged_users": config.privileged_users,
        "thread_welcome_suffix": (
            "Tip: continue the conversation in this thread. "
            "Mention @Virtual TA when the channel requires mentions."
        ),
        "editable_files": {
            "residency": f"memory/{config.course_slug}__residency.md",
            "faq": f"memory/{config.course_slug}__faq.md",
            "quick-reference": f"memory/{config.course_slug}__quick-reference.md",
        },
    }


def canvas_config(config: DeploymentConfig) -> dict:
    return {
        "version": 1,
        "default_sync_interval_hours": config.canvas_sync_interval_hours,
        "active_courses": [
            {
                "canvas_id": config.canvas_course_id,
                "slug": config.course_slug,
                "name": config.course_name,
                "role": "teacher",
                "term": config.semester,
                "discord_channels": config.discord_channels,
                "sync_enabled": True,
                "sync_interval_hours": config.canvas_sync_interval_hours,
                "sync_content": {
                    "pages": True,
                    "assignments": True,
                    "announcements": True,
                    "discussions": True,
                    "modules": True,
                    "quizzes": True,
                    "files": True,
                    "syllabus": True,
                    "enrollments": True,
                },
                "mapped_at": None,
                "last_sync": None,
            }
        ],
        "ignored_courses": [],
        "file_download_rules": {
            "max_file_size_mb": 50,
            "allowed_extensions": [".pdf", ".docx", ".pptx", ".xlsx", ".txt", ".csv", ".ipynb"],
            "skip_extensions": [".mp4", ".mov", ".zip", ".tar"],
        },
    }


def per_course_config(config: DeploymentConfig) -> dict:
    return {
        "canvas_id": config.canvas_course_id,
        "slug": config.course_slug,
        "course_name": config.course_name,
        "course_code": config.course_code,
        "section": config.course_section,
        "role": "teacher",
        "term": config.semester,
        "canvas_url": f"{config.canvas_base_url}/courses/{config.canvas_course_id}",
        "discord_channels": [f"channel:{channel}" for channel in config.discord_channels],
        "blocked_channels": [f"channel:{channel}" for channel in config.discord_blocked_channels],
        "admin_users": config.admin_users,
        "privileged_users": config.privileged_users,
        "editable_files": course_ta_config(config)["editable_files"],
    }


def canvas_credentials(config: DeploymentConfig) -> dict:
    return {
        "canvas_base_url": config.canvas_base_url,
        "access_token": config.canvas_access_token,
    }


def workspace_agents(config: DeploymentConfig) -> str:
    return f"""# Course TA Agent Instructions

For every Discord guild message delivered to this agent, read:
`{config.skill_dir / 'SKILL.md'}`

Run the skill's `ta_preflight.py` before producing a reply. Obey blocked-channel,
rate-limit, thread, source-precedence, privacy, and academic-integrity rules.

The active course is {config.course_name} ({config.semester}). Course routing
and administrator identities must be read from `course-ta.json`; do not disclose
those internal values in a guild channel.
"""
