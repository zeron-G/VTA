import tempfile
import unittest
from pathlib import Path

from course_ta_deployer.config import load_config
from course_ta_deployer.deployment import Deployer, DeploymentOptions, SafeWriter
from course_ta_deployer.runner import CommandResult
from tests.helpers import base_env


class DeploymentTests(unittest.TestCase):
    def test_full_dry_run_has_no_writes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            config = load_config(environ=base_env(root))
            deployer = Deployer(
                config,
                DeploymentOptions(dry_run=True, skip_auth=True, skip_gateway=True),
            )
            result = deployer.execute()
            self.assertTrue(result["dry_run"])
            self.assertFalse(config.state_dir.exists())
            self.assertGreater(len(deployer.runner.history), 0)

    def test_writer_is_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            writer = SafeWriter(root, dry_run=False)
            target = root / "config.json"
            self.assertTrue(writer.write_text(target, "{}\n"))
            self.assertFalse(writer.write_text(target, "{}\n"))

    def test_pinned_openclaw_version_is_upgraded(self):
        class FakeRunner:
            def __init__(self):
                self.history = []
                self.installed = False

            def which(self, command):
                return f"/bin/{command}"

            def run(self, args, **kwargs):
                command = [str(arg) for arg in args]
                self.history.append(command)
                if command[-1] == "--version" and command[0].endswith("node"):
                    return CommandResult(command, 0, "v22.19.0\n", "")
                if "install" in command:
                    self.installed = True
                    return CommandResult(command, 0, "", "")
                if command[-1] == "--version":
                    version = "2026.6.8" if self.installed else "2026.2.22-2"
                    return CommandResult(command, 0, version + "\n", "")
                return CommandResult(command, 0, "", "")

        with tempfile.TemporaryDirectory() as td:
            config = load_config(environ=base_env(Path(td)))
            deployer = Deployer(config, DeploymentOptions())
            fake = FakeRunner()
            deployer.runner = fake

            deployer.ensure_openclaw()

            self.assertTrue(fake.installed)
            self.assertIn(
                ["/bin/npm", "install", "-g", "openclaw@2026.6.8"],
                fake.history,
            )


if __name__ == "__main__":
    unittest.main()
