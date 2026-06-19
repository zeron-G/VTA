#!/usr/bin/env python3
"""Sync allowed_channels/blocked_channels in course-ta.json from openclaw.json.

openclaw.json is the canonical source for Discord channel registration — the
OpenClaw gateway requires it to function. course-ta.json's allowed_channels
and blocked_channels are a derived view consumed by the skill prompt logic.

This script reads channels.discord.guilds.*.channels from openclaw.json and
rewrites those two arrays in course-ta.json. All other fields in
course-ta.json are preserved. Channels with `enabled: false` are written to
blocked_channels; all other listed channels go to allowed_channels.

Run after editing openclaw.json:
    python lib/sync_channels.py
or:
    python lib/sync_channels.py --install-root ~/.openclaw-course-ta
    python lib/sync_channels.py --dry-run
"""

import argparse
import json
import os
import sys
from pathlib import Path


def derive_channels(openclaw_cfg):
    allowed = []
    blocked = []
    guilds = (
        openclaw_cfg.get("channels", {})
        .get("discord", {})
        .get("guilds", {})
    )
    for _guild_id, guild in guilds.items():
        for channel_id, rules in (guild.get("channels") or {}).items():
            target = f"channel:{channel_id}"
            if isinstance(rules, dict) and rules.get("enabled") is False:
                blocked.append(target)
            else:
                allowed.append(target)
    return allowed, blocked


def main():
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
    )
    parser.add_argument(
        "--install-root",
        default=os.environ.get(
            "OPENCLAW_STATE_DIR",
            str(Path.home() / ".openclaw-course-ta"),
        ),
        help="OpenClaw install root (contains openclaw.json and workspace/)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the derived lists without writing course-ta.json",
    )
    args = parser.parse_args()

    root = Path(args.install_root).expanduser()
    openclaw_path = root / "openclaw.json"
    course_ta_path = root / "workspace" / "course-ta.json"

    if not openclaw_path.exists():
        print(f"ERROR: {openclaw_path} not found", file=sys.stderr)
        return 1
    if not course_ta_path.exists():
        print(f"ERROR: {course_ta_path} not found", file=sys.stderr)
        return 1

    openclaw_cfg = json.loads(openclaw_path.read_text())
    allowed, blocked = derive_channels(openclaw_cfg)

    course_ta = json.loads(course_ta_path.read_text())
    prev_allowed = course_ta.get("allowed_channels", [])
    prev_blocked = course_ta.get("blocked_channels", [])

    course_ta["allowed_channels"] = allowed
    course_ta["blocked_channels"] = blocked

    print(f"install root:    {root}")
    print(f"openclaw.json:   {openclaw_path}")
    print(f"course-ta.json:  {course_ta_path}")
    print(f"allowed_channels: {prev_allowed} -> {allowed}")
    print(f"blocked_channels: {prev_blocked} -> {blocked}")

    if args.dry_run:
        print("(dry-run; not written)")
        return 0

    if prev_allowed == allowed and prev_blocked == blocked:
        print("no change.")
        return 0

    tmp = course_ta_path.with_suffix(course_ta_path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(course_ta, indent=2, ensure_ascii=False) + "\n"
    )
    tmp.replace(course_ta_path)
    print("written.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
