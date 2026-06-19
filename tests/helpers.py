from pathlib import Path


def base_env(root: Path) -> dict[str, str]:
    skill = root / "source-skill"
    (skill / "lib").mkdir(parents=True)
    (skill / "SKILL.md").write_text("# test skill\n", encoding="utf-8")
    (skill / "lib" / "paths.py").write_text("# test paths\n", encoding="utf-8")
    return {
        "COURSE_TA_PROFILE": "test-course",
        "COURSE_TA_STATE_DIR": str(root / "state"),
        "COURSE_TA_SKILL_SOURCE": str(skill),
        "COURSE_TA_MODEL_AUTH": "codex-oauth",
        "COURSE_TA_CANVAS_BASE_URL": "https://canvas.example.edu",
        "COURSE_TA_CANVAS_ACCESS_TOKEN": "canvas-secret",
        "COURSE_TA_CANVAS_COURSE_ID": "123456",
        "COURSE_TA_DISCORD_BOT_TOKEN": "discord-secret",
        "COURSE_TA_DISCORD_GUILD_ID": "123456789012345678",
        "COURSE_TA_DISCORD_CHANNELS": "123456789012345679",
        "COURSE_TA_ADMIN_USERS": "123456789012345680",
        "COURSE_TA_COURSE_SLUG": "test-course",
        "COURSE_TA_COURSE_NAME": "Test Course",
        "COURSE_TA_INSTALL_PYTHON_DEPS": "false",
        "COURSE_TA_INITIAL_CANVAS_SYNC": "false",
        "COURSE_TA_INSTALL_GATEWAY": "false",
    }
