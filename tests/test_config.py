import json
import tempfile
import unittest
from pathlib import Path

from course_ta_deployer.config import (
    ConfigError,
    load_config,
    load_dotenv,
    missing_required_settings,
)
from tests.helpers import base_env


class ConfigTests(unittest.TestCase):
    def test_loads_channel_urls_and_redacts_secrets(self):
        with tempfile.TemporaryDirectory() as td:
            env = base_env(Path(td))
            env["COURSE_TA_DISCORD_CHANNELS"] = (
                "https://discord.com/channels/123456789012345678/123456789012345679"
            )
            config = load_config(environ=env)
            self.assertEqual(config.discord_channels, ["123456789012345679"])
            rendered = json.dumps(config.redacted())
            self.assertNotIn("canvas-secret", rendered)
            self.assertNotIn("discord-secret", rendered)
            self.assertEqual(config.redacted()["canvas_access_token"], "<set>")

    def test_accepts_environment_aliases(self):
        with tempfile.TemporaryDirectory() as td:
            env = base_env(Path(td))
            env["CANVAS_API_TOKEN"] = env.pop("COURSE_TA_CANVAS_ACCESS_TOKEN")
            env["DISCORD_BOT_TOKEN"] = env.pop("COURSE_TA_DISCORD_BOT_TOKEN")
            config = load_config(environ=env)
            self.assertEqual(config.canvas_access_token, "canvas-secret")
            self.assertEqual(config.discord_bot_token, "discord-secret")

    def test_rejects_invite_link(self):
        with tempfile.TemporaryDirectory() as td:
            env = base_env(Path(td))
            env["COURSE_TA_DISCORD_CHANNELS"] = "https://discord.gg/example"
            with self.assertRaises(ConfigError):
                load_config(environ=env)

    def test_api_key_mode_requires_key(self):
        with tempfile.TemporaryDirectory() as td:
            env = base_env(Path(td))
            env["COURSE_TA_MODEL_AUTH"] = "openai-api-key"
            with self.assertRaises(ConfigError):
                load_config(environ=env)

    def test_dotenv_does_not_interpolate_or_execute(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / ".env"
            path.write_text("A='$(whoami)'\nB=plain # comment\n", encoding="utf-8")
            values = load_dotenv(path)
            self.assertEqual(values["A"], "$(whoami)")
            self.assertEqual(values["B"], "plain")

    def test_dotenv_preserves_unicode(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / ".env"
            path.write_text('COURSE="人工智能课程"\n', encoding="utf-8")
            self.assertEqual(load_dotenv(path)["COURSE"], "人工智能课程")

    def test_unrelated_process_secrets_are_not_retained(self):
        with tempfile.TemporaryDirectory() as td:
            env = base_env(Path(td))
            env["UNRELATED_DATABASE_PASSWORD"] = "do-not-retain"
            config = load_config(environ=env)
            self.assertNotIn("UNRELATED_DATABASE_PASSWORD", config.source_env)

    def test_missing_settings_are_reported_together(self):
        missing = missing_required_settings(environ={"COURSE_TA_MODEL_AUTH": "openai-api-key"})
        names = {name for _, name in missing}
        self.assertIn("COURSE_TA_CANVAS_BASE_URL", names)
        self.assertIn("COURSE_TA_CANVAS_ACCESS_TOKEN", names)
        self.assertIn("COURSE_TA_DISCORD_BOT_TOKEN", names)
        self.assertIn("COURSE_TA_COURSE_NAME", names)
        self.assertIn("OPENAI_API_KEY", names)
        self.assertGreaterEqual(len(names), 10)

    def test_placeholder_values_are_reported_as_missing(self):
        with tempfile.TemporaryDirectory() as td:
            env = base_env(Path(td))
            env["COURSE_TA_CANVAS_ACCESS_TOKEN"] = "REPLACE_ME"
            env["COURSE_TA_COURSE_NAME"] = "Replace Me Course"
            names = {name for _, name in missing_required_settings(environ=env)}
            self.assertIn("COURSE_TA_CANVAS_ACCESS_TOKEN", names)
            self.assertIn("COURSE_TA_COURSE_NAME", names)


if __name__ == "__main__":
    unittest.main()
