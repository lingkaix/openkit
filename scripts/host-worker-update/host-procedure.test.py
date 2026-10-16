"""Fixed procedure admission and real bounded subprocesses; no live host effects."""

import hashlib
from contextlib import ExitStack
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


class ProcedureTests(unittest.TestCase):
    """Command doubles prove step routing only, never real systemd qualification."""

    def scenario(self, action):
        """Replace all host boundaries before the root-only entry can observe them."""
        stack = ExitStack()
        self.addCleanup(stack.close)
        value = request(action)
        archive = b"synthetic verified archive bytes"
        machine = b"00000000000000000000000000000001\n"
        value["target"]["archiveSha256"] = hashlib.sha256(archive).hexdigest()
        digest = hashlib.sha256(machine).hexdigest()
        events = []
        checks = 0
        class Manager:
            """Explicit external manager facts; no production filesystem is reached."""
            def __init__(self, identifier):
                self.identifier = identifier
                self.attempt = "synthetic fixed attempted-start artifact"
            def _admit(self): pass
            def _unit_roots(self, guarded): events.append(("roots", guarded))
            def _activation(self): pass
            def _guard(self): pass
            def _conditions(self): pass
            def _owned(self, *_args): pass
            def _attempt_bytes(self): return b"synthetic attempt"
            def _old_unit(self, selected): self.selected = selected
            def _bus(self, *_args): return []
            def _incarnation(self, _guarded): return dict(STAMP)
            def _payloads(self, selected): events.append(("payloads", selected))
            def assert_fenced_and_inhibited(self): events.append(("fence",))
            def begin(self, selected): events.append(("begin", selected))
            def start_once(self, selected): events.append(("start", selected)); return dict(STAMP)
            def finalize(self, process, selected): events.append(("finalize", process, selected))
        def read(path, **_options):
            if path == Path("/etc/machine-id"):
                return machine, ()
            self.assertEqual(path, Path("/usr/lib/openkit/.openkit-operator-input-" + IDENTIFIER) /
                "openkit-nanohost-v0.1.0-rc.8-linux-arm64.tar.gz")
            return archive, ()
        def run(argv, **options):
            nonlocal checks
            events.append(("command", argv))
            if argv[-1] == "--check-host":
                return json.dumps(dict(hardVerdict="requirements-met", archiveSha256=value["target"]["archiveSha256"],
                    productCommit=value["target"]["sourceCommit"], machineIdentityDigest=digest)).encode()
            if argv[-1] == "--check":
                checks += 1
                return b"destination=resumable\n" if checks == 1 else b"destination=already-installed\n"
            if argv[-1].endswith("/install.sh"):
                return b"installation=complete\nremaining=configuration,enrollment,service-start\n"
            if argv[-1] == "inspect":
                selected = value["old"] if action == "preflight" else value["target"]
                return json.dumps(dict(outcome="observed", nonce=json.loads(options["input_bytes"])["nonce"],
                    coordinator=STAMP, replacementDuringMeasurement=False,
                    executables=dict(nanohost=dict(sha256=selected["payloads"]["nanohostSha256"]),
                                     gateway=dict(sha256=selected["payloads"]["gatewaySha256"])),
                    unit=dict(fileSha256=selected["payloads"]["unitFileSha256"], effectiveStateDigest="f"*64))).encode()
            return b""
        stack.enter_context(mock.patch.object(MODULE.os, "geteuid", return_value=0))
        stack.enter_context(mock.patch.object(MODULE.os, "getegid", return_value=0))
        stack.enter_context(mock.patch.object(MODULE, "_regular", side_effect=read))
        stack.enter_context(mock.patch.object(MODULE, "_inputs", return_value=("0"*64, [("private",)])))
        stack.enter_context(mock.patch.object(MODULE, "_volatile_run"))
        stack.enter_context(mock.patch.object(MODULE, "_run", side_effect=run))
        stack.enter_context(mock.patch.object(MODULE._maintenance, "Maintenance", Manager))
        custody = stack.enter_context(mock.patch.object(MODULE._replacement, "vacate_verified_payloads"))
        return value, digest, events, custody

    def invoke(self, value, digest):
        """Use the production root selector while all actual host effects are doubled."""
        return MODULE.run_step(value, Path("/usr/lib/openkit/.openkit-operator-input-" + IDENTIFIER), digest)

    def test_six_steps_dispatch_only_their_owned_effects(self):
        """No step hides a service start, payload restoration or dependent action."""
        for action in ("preflight", "begin", "vacate", "install", "start", "finalize"):
            with self.subTest(action=action):
                value, digest, events, custody = self.scenario(action)
                result = self.invoke(value, digest)
                self.assertEqual((result["action"], result["outcome"]), (action, "passed"))
                self.assertEqual(sum(event[0] == "start" for event in events), int(action == "start"))
                self.assertEqual(sum(event[0] == "finalize" for event in events), int(action == "finalize"))
                if action == "start":
                    self.assertNotIn("controlledEffectiveStateDigest", result)
                if action == "install":
                    commands = [event[1] for event in events if event[0] == "command"]
                    self.assertEqual(len(commands), 3)
                    self.assertEqual([len(command) for command in commands], [2, 1, 2])
                    self.assertEqual(commands[0][-1], "--check")
                    self.assertEqual(commands[2][-1], "--check")
                if action == "vacate":
                    self.assertEqual(custody.call_args.args[0], {"replacementId": IDENTIFIER,
                        "old": MODULE._payloads(value["old"]), "target": MODULE._payloads(value["target"])})
                else:
                    custody.assert_not_called()

    def test_changed_retained_inputs_refuse_after_install_without_restore_or_start(self):
        """A completed installer cannot turn a failed preservation check into success."""
        value, digest, events, _ = self.scenario("install")
        with mock.patch.object(MODULE, "_inputs", side_effect=[("0"*64, ["before"]), ("1"*64, ["after"])]):
            with self.assertRaises(MODULE.ProcedureRefusal):
                self.invoke(value, digest)
        self.assertEqual(sum(event[0] == "command" for event in events), 3)
        self.assertFalse(any(event[0] in ("start", "finalize") for event in events))

    def test_unknown_start_is_not_reissued_or_finalized(self):
        """Losing the controlled start stops this root procedure once."""
        value, digest, events, _ = self.scenario("start")
        def unknown(_self, _selected):
            events.append(("start",)); raise OSError("PRIVATE_REMOTE_ERROR")
        with mock.patch.object(MODULE._maintenance.Maintenance, "start_once", unknown):
            with self.assertRaises(MODULE.ProcedureRefusal) as caught:
                self.invoke(value, digest)
        self.assertNotIn("PRIVATE", str(caught.exception))
        self.assertEqual(sum(event[0] == "start" for event in events), 1)
        self.assertFalse(any(event[0] == "finalize" for event in events))

    def test_controlled_observation_never_reissues_start(self):
        """Only the external public-readiness bridge can reach this read-only phase."""
        value, digest, events, _ = self.scenario("start")
        result = MODULE.run_step(value, Path("/usr/lib/openkit/.openkit-operator-input-" + IDENTIFIER),
                                 digest, controlled_process=STAMP)
        self.assertEqual(result["controlledEffectiveStateDigest"], "f" * 64)
        self.assertFalse(any(event[0] == "start" for event in events))

    def test_pre_install_check_refusal_prevents_installer(self):
        """A zero-exit conflicting disposition is still an owned refusal."""
        value, digest, events, _ = self.scenario("install")
        with mock.patch.object(MODULE, "_run", return_value=b"destination=destination-conflict\n") as called:
            with self.assertRaises(MODULE.ProcedureRefusal):
                self.invoke(value, digest)
        self.assertEqual(called.call_count, 1)
        self.assertEqual(called.call_args.args[0][-1], "--check")
        self.assertFalse(any(event[0] in ("start", "finalize") for event in events))

    def test_unavailable_native_observation_is_not_refreshed(self):
        """A closed unavailable P02 sample ends the attempt after exactly one read."""
        value, digest, events, _ = self.scenario("start")
        def unavailable(_argv, **options):
            return json.dumps(dict(nonce=json.loads(options["input_bytes"])["nonce"],
                                   outcome="unavailable", reason="connection-unavailable")).encode()
        with mock.patch.object(MODULE, "_run", side_effect=unavailable) as invoked:
            with self.assertRaises(MODULE.ProcedureRefusal):
                MODULE.run_step(value, Path("/usr/lib/openkit/.openkit-operator-input-" + IDENTIFIER),
                                digest, controlled_process=STAMP)
        self.assertEqual(invoked.call_count, 1)
        self.assertFalse(any(event[0] == "start" for event in events))


if __name__ == "__main__":
    unittest.main(verbosity=2)
