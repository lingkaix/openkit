#!/usr/bin/env python3
"""Manual Docker-domain regression: candidate ENV defaults reach the recreated container.

Run explicitly on a disposable Docker-capable developer host:

OPENKIT_TEST_APP_UPDATE_ENV_HOST=1 python3 -I -B scripts/docker/app-update-helper.env-host.test.py

Only uniquely named scratch images and stopped fixture containers are created.

This is separate from the deterministic helper suite and does not inspect a deployment.
"""

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(path, name):
    """Load one checkout-owned module without changing isolated Python's import path."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def docker(*args):
    """Require one bounded real Docker observation or fixture effect."""
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=120, check=True)
    return result.stdout


class CandidateEnvironmentHostTests(unittest.TestCase):
    """Docker owns the oracle for merged image and container environment."""

    def test_candidate_default_changes_and_operator_override_survives(self):
        helper = load(ROOT / "scripts/docker/app-update-helper.py", "helper")
        fixtures = load(ROOT / "scripts/docker/app-update-helper.test.py", "fixtures")
        suffix = uuid.uuid4().hex
        old, candidate = "openkit-env-old:" + suffix, "openkit-env-candidate:" + suffix
        name = "openkit-env-" + suffix
        created = []
        images = []
        with tempfile.TemporaryDirectory(prefix="openkit-env-host-") as tmp:
            root = Path(tmp)
            path = fixtures.write_config(root, containerName=name)
            effects = fixtures.RecordingEffects()
            effects.bind(root)
            try:
                for image, default in ((old, "old"), (candidate, "candidate")):
                    (root / "Dockerfile").write_text(
                        'FROM scratch\nENV RELEASE_DEFAULT=' + default + '\nENV OVERRIDE=image\nCMD ["/not-started"]\n'
                    )
                    docker("build", "--quiet", "--tag", image, str(root))
                    images.append(image)
                old_id = docker("create", "--env", "OVERRIDE=operator", old).strip()
                created.append(old_id)
                actual = json.loads(docker("inspect", old_id))[0]
                inspection = effects._container_payload()
                inspection["Image"] = actual["Image"]
                inspection["Config"]["Env"] = actual["Config"]["Env"]
                instance = helper.AppUpdateHelper(helper.load_config(str(path)), helper.CommandEffects(), lambda: 0)
                argv = instance._replacement_argv(inspection, candidate, "a" * 40)
                # Creation uses exactly the helper's replacement options without starting any process.
                candidate_id = docker("create", *argv[3:]).strip()
                created.append(candidate_id)
                environment = json.loads(docker("inspect", candidate_id))[0]["Config"]["Env"]
                self.assertIn("RELEASE_DEFAULT=candidate", environment)
                self.assertNotIn("RELEASE_DEFAULT=old", environment)
                self.assertIn("OVERRIDE=operator", environment)
            finally:
                for container in reversed(created):
                    docker("rm", container)
                for image in reversed(images):
                    docker("image", "rm", image)


if __name__ == "__main__":
    if os.environ.get("OPENKIT_TEST_APP_UPDATE_ENV_HOST") != "1":
        raise SystemExit("This manual Docker-domain check requires OPENKIT_TEST_APP_UPDATE_ENV_HOST=1.")
    unittest.main()
