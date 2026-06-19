import json
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError

from course_ta_deployer.builders import canvas_credentials, openclaw_config
from course_ta_deployer.config import load_config
from course_ta_deployer.doctor import run_check
from course_ta_deployer.runner import CommandResult
from tests.helpers import base_env


class FakeResponse:
    def __init__(self, payload, status=200):
        self.payload = json.dumps(payload).encode("utf-8")
        self.status = status

    def getcode(self):
        return self.status

    def read(self):
        return self.payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False


class FakeRunner:
    def __init__(self, secrets=()):
        self.secrets = tuple(secrets)
        self.history = []

    def redact(self, text):
        result = str(text)
        for secret in self.secrets:
            result = result.replace(secret, "<redacted>")
        return result

    def which(self, command):
        return f"/bin/{command}"

    def run(self, args, **kwargs):
        command = [str(arg) for arg in args]
        self.history.append(command)
        if command[-1] == "--version" and "node" in command[0]:
            return CommandResult(command, 0, "v22.19.0\n", "")
        if command[-1] == "--version":
            return CommandResult(command, 0, "OpenClaw 2026.5.20\n", "")
        if "models" in command and "status" in command:
            payload = {"auth": {"probes": {"results": [{"status": "ok"}]}}}
            return CommandResult(command, 0, json.dumps(payload), "")
        if "memory" in command and "status" in command:
            return CommandResult(command, 0, '{"status":"ready"}', "")
        return CommandResult(command, 0, "", "")


def prepare_profile(config):
    config.workspace_dir.mkdir(parents=True)
    (config.workspace_dir / "memory").mkdir()
    config.skill_dir.mkdir(parents=True)
    (config.skill_dir / "SKILL.md").write_text("# Course TA\n", encoding="utf-8")
    (config.skill_dir / "config").mkdir()
    (config.skill_dir / "config" / "course-ta.json").write_text("{}\n", encoding="utf-8")
    credentials = config.skill_dir / "data" / "credentials"
    credentials.mkdir(parents=True)
    (credentials / "canvas.json").write_text(
        json.dumps(canvas_credentials(config)), encoding="utf-8"
    )
    config.openclaw_config_path.write_text(
        json.dumps(openclaw_config(config, {})), encoding="utf-8"
    )
    auth = config.state_dir / "agents" / "main" / "agent"
    auth.mkdir(parents=True)
    (auth / "auth-profiles.json").write_text(
        '{"profiles":{"openai-codex:default":{"provider":"openai-codex"}}}',
        encoding="utf-8",
    )


class DoctorTests(unittest.TestCase):
    def test_offline_mode_skips_every_live_check(self):
        with tempfile.TemporaryDirectory() as td:
            config = load_config(environ=base_env(Path(td)))
            prepare_profile(config)
            runner = FakeRunner(config.secrets)

            def unexpected_network(*args, **kwargs):
                raise AssertionError("offline check attempted a network request")

            result = run_check(
                config,
                online=False,
                runner=runner,
                urlopen_fn=unexpected_network,
            )

            self.assertTrue(result["ok"])
            self.assertGreater(result["summary"]["skipped"], 0)
            history = " ".join(" ".join(command) for command in runner.history)
            self.assertNotIn("models status", history)
            self.assertNotIn("memory status", history)

    def test_online_check_probes_oauth_canvas_course_and_discord(self):
        with tempfile.TemporaryDirectory() as td:
            config = load_config(environ=base_env(Path(td)))
            prepare_profile(config)
            runner = FakeRunner(config.secrets)
            requested = []

            def fake_urlopen(request, timeout):
                requested.append((request.full_url, request.get_method(), timeout))
                url = request.full_url
                if url.endswith("/users/self"):
                    return FakeResponse({"id": 42})
                if url.endswith(f"/courses/{config.canvas_course_id}"):
                    return FakeResponse({"id": config.canvas_course_id})
                if url.endswith("/modules?per_page=1"):
                    return FakeResponse([])
                if url.endswith("/users/@me"):
                    return FakeResponse({"id": "99", "bot": True})
                if url.endswith(f"/guilds/{config.discord_guild_id}"):
                    return FakeResponse({"id": config.discord_guild_id})
                if url.endswith(f"/channels/{config.discord_channels[0]}"):
                    return FakeResponse(
                        {
                            "id": config.discord_channels[0],
                            "guild_id": config.discord_guild_id,
                        }
                    )
                raise AssertionError(f"unexpected URL: {url}")

            result = run_check(
                config,
                online=True,
                timeout=3,
                runner=runner,
                urlopen_fn=fake_urlopen,
            )

            self.assertTrue(result["ok"])
            self.assertTrue(all(method == "GET" for _, method, _ in requested))
            commands = runner.history
            oauth = next(command for command in commands if "models" in command)
            self.assertIn("--probe-provider", oauth)
            self.assertEqual(oauth[oauth.index("--probe-provider") + 1], "openai-codex")
            self.assertEqual(oauth[oauth.index("--probe-max-tokens") + 1], "1")
            names = {check["name"]: check["status"] for check in result["checks"]}
            self.assertEqual(names["Canvas API authentication"], "ok")
            self.assertEqual(names["Canvas course access"], "ok")
            self.assertEqual(names["Canvas course modules"], "ok")
            self.assertEqual(names["Discord guild access"], "ok")

    def test_canvas_auth_failure_is_redacted_and_skips_course(self):
        with tempfile.TemporaryDirectory() as td:
            config = load_config(environ=base_env(Path(td)))
            prepare_profile(config)
            runner = FakeRunner(config.secrets)

            def fake_urlopen(request, timeout):
                if request.full_url.endswith("/users/self"):
                    raise HTTPError(request.full_url, 401, "Unauthorized", {}, None)
                if request.full_url.endswith("/users/@me"):
                    return FakeResponse({"id": "99", "bot": True})
                if "/guilds/" in request.full_url:
                    return FakeResponse({"id": config.discord_guild_id})
                if "/channels/" in request.full_url:
                    return FakeResponse(
                        {
                            "id": config.discord_channels[0],
                            "guild_id": config.discord_guild_id,
                        }
                    )
                raise AssertionError(f"unexpected URL: {request.full_url}")

            result = run_check(
                config,
                online=True,
                runner=runner,
                urlopen_fn=fake_urlopen,
            )

            rendered = json.dumps(result)
            self.assertFalse(result["ok"])
            self.assertNotIn(config.canvas_access_token, rendered)
            statuses = {check["name"]: check["status"] for check in result["checks"]}
            self.assertEqual(statuses["Canvas API authentication"], "failed")
            self.assertEqual(statuses["Canvas course access"], "skipped")


if __name__ == "__main__":
    unittest.main()
