#!/usr/bin/env python3
"""ta_preflight.py — One-shot pre-flight check for an inbound Discord message.

Consolidates the three pre-flight tool calls (read course-ta.json + check rate
limit + record rate limit) into a single exec call so the bot's per-turn tool
budget stays small.

Usage:
    python3 ta_preflight.py --channel <channelId> --user <userId> [--no-record]
    python3 ta_preflight.py --channel <channelId> --user <userId> --json

Output (stdout, JSON, single line):
    {
      "allowed": true|false,
      "reason": "ok" | "blocked_channel" | "unlisted_channel" | "rate_limited",
      "role":   "admin" | "privileged" | "standard" | "unknown",
      "slug":   "<active-course-slug>",
      "canvas_id": <int>,
      "course_name": "<name>",
      "course_section": "<section>",
      "rate_limit": { "tier": "...", "count_hour": N, "count_day": N,
                      "max_hour": N, "max_day": N },
      "log_channel": "<id|null>",
      "thread_welcome_suffix": "<text>"
    }

Exit codes:
    0  allowed (proceed with the reply flow)
    1  blocked / silently ignore (do not respond)
    2  rate limited (reply with the standard rate-limit message, then log)
    3  unlisted channel (silently ignore unless sender is admin; the bot
       handles the admin auto-add case)
    9  internal error (prints {"error": "..."})

This script is read-only on course-ta.json. It UPDATES ta-rate-limit.json by
appending the user's timestamp (unless --no-record is set).

Bot usage flow:
    1. exec ta_preflight.py --channel <c> --user <u>      # one call
    2. branch on exit code / "allowed"
    3. if allowed: do material lookup, thread-create, send, log_interaction
"""

from __future__ import annotations
import argparse
import json
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).parent))
from paths import COURSE_TA_CONFIG, OPENCLAW_CONFIG, RATE_LIMIT_STATE  # noqa: E402

ROLE_ADMIN = "admin"
ROLE_PRIVILEGED = "privileged"
ROLE_STANDARD = "standard"
ROLE_UNKNOWN = "unknown"

STANDARD_MAX_HOUR = 20
STANDARD_MAX_DAY = 60


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    with open(path) as f:
        return json.load(f)


def _save_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    tmp.replace(path)


def _channel_key(channel_id: str) -> str:
    """course-ta.json stores ids as 'channel:<id>'; we accept bare ids too."""
    if channel_id.startswith("channel:"):
        return channel_id
    return f"channel:{channel_id}"


def _bare_channel_id(channel_id: str) -> str:
    if channel_id.startswith("channel:"):
        return channel_id.split(":", 1)[1]
    return channel_id


def _discord_token() -> str | None:
    try:
        cfg = _load_json(OPENCLAW_CONFIG)
        token = (((cfg.get("channels") or {}).get("discord") or {}).get("token"))
        return token or None
    except Exception:
        return None


def _discord_channel_info(channel_id: str, token: str) -> dict | None:
    req = Request(
        f"https://discord.com/api/v10/channels/{channel_id}",
        headers={"Authorization": f"Bot {token}", "User-Agent": "OpenClaw Course TA preflight"},
    )
    try:
        with urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
        return None


def _resolve_parent_thread_channel(channel_id: str) -> tuple[str, str | None]:
    """Return (channel_id_to_gate, parent_id_if_thread).

    Discord private/public threads are separate channel ids, but course-ta.json is
    configured with parent course channels (#general, #random, etc.). Let a thread
    inherit the parent channel's allow/block/course mapping.
    """
    bare = _bare_channel_id(channel_id)
    token = _discord_token()
    if not token:
        return channel_id, None
    info = _discord_channel_info(bare, token)
    if not info:
        return channel_id, None
    parent_id = info.get("parent_id")
    # Discord thread channel types: announcement thread=10, public=11, private=12.
    if info.get("type") in (10, 11, 12) and parent_id:
        return parent_id, parent_id
    return channel_id, None


def _resolve_role(cfg: dict, user_id: str) -> tuple[str, int, int]:
    """Return (role, max_hour, max_day) for the user."""
    if user_id in cfg.get("admin_users", []):
        return ROLE_ADMIN, 10_000, 100_000  # effectively no limit
    privileged = cfg.get("privileged_users", {}) or {}
    if user_id in privileged:
        entry = privileged[user_id] or {}
        return (
            ROLE_PRIVILEGED,
            int(entry.get("max_hour", 60)),
            int(entry.get("max_day", 200)),
        )
    return ROLE_STANDARD, STANDARD_MAX_HOUR, STANDARD_MAX_DAY


def _resolve_course(cfg: dict, channel_key: str) -> dict:
    """Return the channel's resolved slug + canvas_id + name, defaulting to
    top-level fields if the channel isn't explicitly mapped."""
    cmap = cfg.get("channel_course_map", {}) or {}
    entry = cmap.get(channel_key) or {}
    return {
        "slug": entry.get("slug") or cfg.get("slug"),
        "canvas_id": entry.get("canvas_id") or cfg.get("canvas_id"),
        "course_name": cfg.get("course_name"),
        "course_section": entry.get("section") or cfg.get("course_section"),
    }


def _count_recent(timestamps: list[float], window_seconds: int, now: float) -> int:
    cutoff = now - window_seconds
    return sum(1 for t in timestamps if t >= cutoff)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--channel", required=True, help="Discord channel id (bare or 'channel:<id>')")
    ap.add_argument("--user", required=True, help="Discord user id (sender)")
    ap.add_argument("--no-record", action="store_true",
                    help="Skip recording this message in rate-limit state. Use when the bot will silently ignore.")
    ap.add_argument("--json", action="store_true", help="Force JSON output (default behavior).")
    args = ap.parse_args()

    try:
        cfg = _load_json(COURSE_TA_CONFIG)
    except Exception as e:
        print(json.dumps({"error": f"failed to read course-ta.json: {e}"}))
        return 9

    gate_channel_id, parent_channel_id = _resolve_parent_thread_channel(args.channel)
    channel_key = _channel_key(gate_channel_id)
    user_id = str(args.user)
    now = time.time()

    # ----- channel gating -----
    blocked = cfg.get("blocked_channels", []) or []
    allowed = cfg.get("allowed_channels", []) or []

    role, max_hour, max_day = _resolve_role(cfg, user_id)
    is_admin = role == ROLE_ADMIN

    course = _resolve_course(cfg, channel_key)

    base_result = {
        "role": role,
        "slug": course["slug"],
        "canvas_id": course["canvas_id"],
        "course_name": course["course_name"],
        "course_section": course["course_section"],
        "log_channel": cfg.get("log_channel") or None,
        "thread_welcome_suffix": cfg.get("thread_welcome_suffix", ""),
        "parent_channel_id": parent_channel_id,
    }

    if channel_key in blocked:
        out = {**base_result, "allowed": False, "reason": "blocked_channel"}
        print(json.dumps(out))
        return 1

    wildcard_allow = "*" in allowed or "channel:*" in allowed
    if allowed and not wildcard_allow and channel_key not in allowed and not is_admin:
        out = {**base_result, "allowed": False, "reason": "unlisted_channel"}
        print(json.dumps(out))
        return 3

    # ----- rate limit -----
    # State schema: { "<userId>": { "messages": [<unix-seconds>, ...] } }
    state = _load_json(RATE_LIMIT_STATE)
    user_entry = state.get(user_id) or {}
    history = user_entry.get("messages") or []
    # prune entries older than 24h to keep the state file bounded
    history = [float(t) for t in history if (now - float(t)) < 24 * 3600]

    count_hour = _count_recent(history, 3600, now)
    count_day = len(history)

    if not is_admin and (count_hour >= max_hour or count_day >= max_day):
        out = {
            **base_result,
            "allowed": False,
            "reason": "rate_limited",
            "rate_limit": {
                "tier": role,
                "count_hour": count_hour,
                "count_day": count_day,
                "max_hour": max_hour,
                "max_day": max_day,
            },
        }
        print(json.dumps(out))
        return 2

    # ----- record -----
    if not args.no_record:
        history.append(now)
        state[user_id] = {"messages": history}
        _save_json(RATE_LIMIT_STATE, state)
        count_hour = _count_recent(history, 3600, now)
        count_day = len(history)

    out = {
        **base_result,
        "allowed": True,
        "reason": "ok",
        "rate_limit": {
            "tier": role,
            "count_hour": count_hour,
            "count_day": count_day,
            "max_hour": max_hour,
            "max_day": max_day,
        },
    }
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
