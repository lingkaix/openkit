"""Fixed procedure admission and real bounded subprocesses; no live host effects."""

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("host_procedure", Path(__file__).with_name("host-procedure.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
IDENTIFIER = "41830d22-d653-4838-ae3b-0ad78819b2fe"
STAMP = {"bootId": "3c62645e-b416-4dca-bdcf-38877ac09393", "pid": 4412, "startTimeTicks": "1002098"}


def attribution():
    """Supply fixed independent publication facts for request parsing."""
    return {"archiveSha256": "a" * 64, "tag": "v0.1.0-rc.8", "sourceCommit": "b" * 40,
            "platform": "linux/arm64", "payloads": {"nanohostSha256": "c" * 64,
            "gatewaySha256": "d" * 64, "unitFileSha256": "e" * 64}}


def request(action="preflight"):
    """Build one finite request with no host paths or commands."""
    value = {"action": action, "replacementId": IDENTIFIER, "old": attribution(), "target": attribution()}
    if action == "finalize":
        value["process"] = dict(STAMP)
    return value


class RequestTests(unittest.TestCase):
    """A malformed authority-bearing request stops before host observation."""

    def test_all_six_actions_have_closed_data_shapes(self):
        """Only the existing six fixed steps are admitted."""
        for action in ("preflight", "begin", "vacate", "install", "start", "finalize"):
            self.assertEqual(MODULE._request(request(action)), IDENTIFIER)

    def test_unknown_selectors_and_malformed_authority_stop_before_read(self):
        """A caller cannot redirect a command, path, process or selected archive."""
        cases = []
        for key in ("command", "service", "root", "workspace", "credential"):
            value = request(); value[key] = "synthetic selector"; cases.append(value)
        value = request(); value["action"] = "restore"; cases.append(value)
        value = request(); value["replacementId"] = IDENTIFIER.upper(); cases.append(value)
        value = request(); value["target"]["payloads"]["unknown"] = "a" * 64; cases.append(value)
        value = request(); value["target"]["sourceCommit"] = "bad"; cases.append(value)
        value = request(); value["target"]["platform"] = "linux/amd64"; cases.append(value)
        value = request("finalize"); value["process"]["pid"] = True; cases.append(value)
        with mock.patch.object(MODULE, "_regular", side_effect=AssertionError("host observation reached")):
            for value in cases:
                with self.subTest(value=value):
                    with self.assertRaises(MODULE.ProcedureRefusal) as caught:
                        MODULE.run_step(value, Path("/synthetic"), "a" * 64)
                    self.assertEqual(str(caught.exception),
                        "NanoHost operator step unavailable; inspect retained custody before any new effect.")


class CollectorTests(unittest.TestCase):
    """The actual collector enforces its bounds without command doubles."""

    def test_exact_small_stdin_is_received_once(self):
        """The prefilled pipe supplies the exact native nonce-sized request."""
        result = MODULE._systemd.bounded_default([sys.executable, "-I", "-B", "-c",
            "import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())"], input_bytes=b"synthetic nonce")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"synthetic nonce", b""))

    def test_invalid_limits_and_large_stdin_refuse_before_spawn(self):
        """No invalid resource instruction can create a process."""
        for options in ({"input_bytes": b"x" * 129}, {"input_bytes": "text"},
                        {"timeout_seconds": float("inf")}, {"timeout_seconds": 181},
                        {"max_stdout_bytes": True}, {"max_stderr_bytes": 4097}):
            with mock.patch.object(MODULE._systemd.subprocess, "Popen", side_effect=AssertionError("spawn reached")):
                with self.assertRaises(Exception):
                    MODULE._systemd.bounded_default(["never-selected"], **options)

    def test_output_overflow_is_not_a_truncated_success(self):
        """Both actual output streams are measured while collected."""
        for stream, options in (("stdout", {"max_stdout_bytes": 8}), ("stderr", {"max_stderr_bytes": 8})):
            with self.assertRaises(Exception):
                MODULE._systemd.bounded_default([sys.executable, "-I", "-B", "-c",
                    "import sys;sys." + stream + ".write('x'*4096)"], **options)

    def test_actual_timeout_has_no_raw_diagnostic(self):
        """A blocked child is killed and a fixed refusal leaves no process running."""
        with self.assertRaises(Exception) as caught:
            MODULE._systemd.bounded_default([sys.executable, "-I", "-B", "-c",
                "import time;time.sleep(30)"], timeout_seconds=0.1)
        self.assertNotIn("sleep", str(caught.exception))


class InputTests(unittest.TestCase):
    """Retained input comparisons keep private values in memory."""

    def test_secret_change_affects_private_comparison_without_exposing_token_hash(self):
        """Public custody digest uses metadata; install compares actual bytes privately."""
        env = ("OPENKIT_NANOHOST_IDENTITY_ID=synthetic\n"
               "OPENKIT_NANOHOST_DEPLOYMENT_ID=synthetic\n"
               "OPENKIT_NANOHOST_NANOCORE_RENDEZVOUS_URL=https://example.test/native\n")
        for key in MODULE._PATH_KEYS[:4]:
            env += key + "=/etc/openkit/synthetic-" + key.lower() + "\n"
        stamp = (1, 2, 0o100600, 0, 0, 8, 10, 10)
        content = b"invented-first-value"
        def read(path, **_options):
            return (env.encode() if path.name == "nanohost.env" else content), stamp
        with mock.patch.object(MODULE, "_regular", side_effect=read):
            public_before, private_before = MODULE._inputs()
            content = b"invented-other-value"
            public_after, private_after = MODULE._inputs()
        self.assertEqual(public_before, public_after)
        self.assertNotEqual(private_before, private_after)
        self.assertNotIn(hashlib.sha256(content).hexdigest(), public_after)

    def test_unsupported_environment_syntax_is_a_pre_effect_refusal(self):
        """A shell-like input is never evaluated or silently reinterpreted."""
        with mock.patch.object(MODULE, "_regular", return_value=(b"KEY=$(synthetic command)\n", ())):
            with self.assertRaises(MODULE.ProcedureRefusal):
                MODULE._inputs()


if __name__ == "__main__":
    unittest.main(verbosity=2)
