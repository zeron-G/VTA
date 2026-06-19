import tempfile
import unittest
from pathlib import Path

from course_ta_deployer.builders import openclaw_config
from course_ta_deployer.config import load_config
from tests.helpers import base_env


class BuilderTests(unittest.TestCase):
    def test_discord_is_allowlisted_without_wildcard(self):
        with tempfile.TemporaryDirectory() as td:
            config = load_config(environ=base_env(Path(td)))
            built = openclaw_config(config)
            discord = built["channels"]["discord"]
            channels = discord["guilds"][config.discord_guild_id]["channels"]
            self.assertEqual(discord["groupPolicy"], "allowlist")
            self.assertNotIn("*", channels)
            self.assertTrue(channels[config.discord_channels[0]]["requireMention"])

    def test_merge_preserves_unmanaged_configuration_and_gateway_token(self):
        with tempfile.TemporaryDirectory() as td:
            config = load_config(environ=base_env(Path(td)))
            existing = {
                "custom": {"keep": True},
                "gateway": {"auth": {"mode": "token", "token": "existing-token"}},
            }
            built = openclaw_config(config, existing)
            self.assertTrue(built["custom"]["keep"])
            self.assertEqual(built["gateway"]["auth"]["token"], "existing-token")

    def test_existing_wildcard_is_removed(self):
        with tempfile.TemporaryDirectory() as td:
            config = load_config(environ=base_env(Path(td)))
            existing = {
                "channels": {
                    "discord": {
                        "guilds": {
                            config.discord_guild_id: {"channels": {"*": {"requireMention": True}}}
                        }
                    }
                }
            }
            built = openclaw_config(config, existing)
            channels = built["channels"]["discord"]["guilds"][config.discord_guild_id]["channels"]
            self.assertNotIn("*", channels)


if __name__ == "__main__":
    unittest.main()
