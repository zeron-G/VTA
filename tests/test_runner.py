import unittest

from course_ta_deployer.runner import Runner


class RunnerTests(unittest.TestCase):
    def test_dry_run_does_not_execute_and_redacts(self):
        runner = Runner(dry_run=True, verbose=False, secrets=("secret-value",))
        result = runner.run(["example", "--token", "secret-value"])
        self.assertTrue(result.skipped)
        self.assertIn("<redacted>", runner.format_command(result.args))
        self.assertNotIn("secret-value", runner.format_command(result.args))


if __name__ == "__main__":
    unittest.main()
