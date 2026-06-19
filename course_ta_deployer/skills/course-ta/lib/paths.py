"""Centralized path resolution for the Course TA skill module.

All paths are derived from the skill root directory (two levels up from this file).
This file is install-agnostic — it resolves correctly when copied between profiles.

Layout:
    lib/              Python modules (this file lives here)
    config/           Runtime configs (course-ta.json, canvas-config.json, etc.)
    data/
      courses/        Course content (Canvas sync cache, GDrive slides)
      memory/         Generated markdown files for RAG indexing
      logs/           Interaction audit logs (JSONL per day)
      credentials/    API tokens (gitignored)
      tests/          Test checklists
"""

import os
from pathlib import Path

# Skill root: two levels up from lib/paths.py
SKILL_DIR = Path(__file__).resolve().parent.parent


def _state_dir() -> Path:
    configured = os.environ.get("OPENCLAW_STATE_DIR")
    if configured:
        return Path(configured).expanduser()
    profile = os.environ.get("OPENCLAW_PROFILE", "course-ta")
    return Path.home() / f".openclaw-{profile}"


OPENCLAW_STATE_DIR = _state_dir()
OPENCLAW_CONFIG = Path(
    os.environ.get("OPENCLAW_CONFIG_PATH", OPENCLAW_STATE_DIR / "openclaw.json")
).expanduser()

# Configuration
CONFIG_DIR = SKILL_DIR / "config"
COURSE_TA_CONFIG = CONFIG_DIR / "course-ta.json"
CANVAS_CONFIG = CONFIG_DIR / "canvas-config.json"
COURSE_CONFIGS_DIR = CONFIG_DIR / "course-configs"
RATE_LIMIT_STATE = CONFIG_DIR / "ta-rate-limit.json"

# Data
DATA_DIR = SKILL_DIR / "data"
COURSES_DIR = DATA_DIR / "courses"
MEMORY_DIR = DATA_DIR / "memory"
LOGS_DIR = DATA_DIR / "logs"
CREDENTIALS_DIR = DATA_DIR / "credentials"
CANVAS_CREDENTIALS = CREDENTIALS_DIR / "canvas.json"

# Analytics outputs live outside the skill (read-only data products for the user).
DISCORD_COUNTS_DIR = Path.home() / "Downloads" / "vta_discord_counts"
