import unittest

from virtual_teaching_assistant.domain.errors import ConfigurationError
from virtual_teaching_assistant.runtime.config import PlatformConfig


def production_env(**overrides):
    values = {
        "VTA_STAGE": "production",
        "VTA_AUDIT_HMAC_KEY": "a" * 32,
        "VTA_ENABLE_NATIVE": "true",
        "VTA_ENABLE_CODEX_CLI": "false",
        "VTA_ENABLE_OPENCLAW": "false",
    }
    values.update(overrides)
    return values


class PlatformConfigTests(unittest.TestCase):
    def test_production_rejects_experimental_oauth(self):
        with self.assertRaises(ConfigurationError):
            PlatformConfig.from_env(
                production_env(VTA_ALLOW_EXPERIMENTAL_OAUTH="true")
            )

    def test_production_requires_agent_isolation(self):
        with self.assertRaises(ConfigurationError):
            PlatformConfig.from_env(
                production_env(
                    VTA_ENABLE_CODEX_CLI="true",
                    VTA_CODEX_ISOLATED="false",
                )
            )
        with self.assertRaises(ConfigurationError):
            PlatformConfig.from_env(
                production_env(
                    VTA_ENABLE_OPENCLAW="true",
                    VTA_OPENCLAW_ISOLATED="false",
                )
            )

    def test_valid_production_config_redacts_audit_key(self):
        config = PlatformConfig.from_env(production_env())
        self.assertTrue(config.production)
        self.assertEqual(config.redacted()["audit_hmac_key"], "<set>")
        self.assertNotIn("a" * 32, repr(config.audit_hmac_key))


if __name__ == "__main__":
    unittest.main()
