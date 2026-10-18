"""Offline lifecycle regressions for the prepared upgrade fixture."""

import importlib.util
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "upgrade_guest", Path(__file__).with_name("upgrade-from-previous-guest.py")
)
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)


class StandIn(DRIVER.Boundary):
    """Stand in only at process, Engine, HTTP and kernel observation boundaries."""

    def __init__(self, input):
        """Prepare exact prior/candidate Engine metadata and observable events."""
        self.input = input
        self.events = []
        self.running = True
        self.host_active = True
        self.current = "previous"
        self.id = "old-container"
        self.bad_proof = False
        self.failed_worker = None
        self.downgrade_prior_image = False
        self.reader = None
        self.carrier = {"Id": "carrier", "State": {"Running": True, "Pid": 123}}

    def namespace(self, pid):
        """Observe a private shared fixture namespace, distinct from the host."""
        return "host" if pid in (1, os.getpid()) else "guest"

    def image_id(self, revision, key):
        """Keep Docker config identities distinct from published OCI identities."""
        value = {("previous", "appImage"): "a", ("candidate", "appImage"): "b",
                 ("previous", "workerImage"): "c", ("candidate", "workerImage"): "d"}[(revision, key)]
        return "sha256:" + value * 64

    def process_root(self, pid):
        """Bind the guest leader to its prepared private root."""
        return Path(self.input["preparedLayout"]["guestRoot"])

    def guest_digest(self, pid, path):
        """Observe prepared bytes through the stand-in guest mount view."""
        return DRIVER.digest(Path(self.input["preparedLayout"]["guestRoot"]) / path.lstrip("/"))

    def docker(self, path, body=None, method="GET"):
        """Model Engine operations without starting any container."""
        if path == "/containers/lrt-p14-network/json":
            return self.carrier
        if path.startswith("/containers/json?"):
            return []
        if path == "/images/json?digests=1":
            return [{"Id": self.image_id(name, key), "RepoDigests": ["example.invalid/image@" + self.input[name][key]]}
                    for name in ("previous", "candidate") for key in ("appImage", "workerImage")]
        if path == "/containers/create?name=lrt-p14-upgrade-reader":
            self.reader = body
            assert body["HostConfig"]["NetworkMode"] == "none"
            assert body["Image"] == self.image_id(self.current, "appImage")
            return {"Id": "owned-reader"}
        if path == "/containers/owned-reader/json":
            return {"State": {"Running": False, "ExitCode": 0}}
        if path == "/containers/owned-reader" and method == "DELETE":
            return None
        if path.startswith("/images/"):
            pin = path[len("/images/"):-len("/json")]
            name, key = next((name, key) for name in ("previous", "candidate") for key in ("appImage", "workerImage")
                             if pin == self.image_id(name, key))
            return {"Id": self.image_id(name, key), "RepoDigests": ["example.invalid/image@" + self.input[name][key]],
                    "Config": {"Env": ["BAKED=" + name], "Labels": {
                "org.opencontainers.image.revision": self.input[name]["commit"],
                "org.opencontainers.image.version": "0.1.0-rc.9",
            }}}
        if path.endswith("/json"):
            return {"Id": self.id, "Name": "/lrt-p14-upgrade", "State": {"Running": self.running},
                    "Image": self.image_id(self.current, "appImage"),
                    "Config": {"Env": ["PRIVATE=never-print", "BAKED=" + self.current]},
                    "HostConfig": {"NetworkMode": "container:lrt-p14-network"},
                    "Mounts": [{"Destination": "/data/openkit", "Source": self.input["dataRoot"],
                                "Type": "bind", "RW": True}]}
        if "/stop?" in path:
            self.events.append("app-stop")
            self.running = False
        elif path.endswith("/start"):
            self.events.append(self.current + "-app-start")
            self.running = True
        elif "/rename?" in path:
            self.events.append("candidate-mutation")
            backup = Path(self.input["retainedRoot"]) / "whole-state"
            sources = json.loads((backup / "recovery.json").read_text())["sources"]
            for index, source in enumerate(sources):
                for child in Path(source).rglob("*"):
                    if child.is_file():
                        assert (backup / str(index) / child.relative_to(source)).read_bytes() == child.read_bytes()
        elif path.startswith("/containers/create?"):
            self.current = "candidate"
            self.id = "new-container"
            assert body["Env"] == ["PRIVATE=never-print"]
            return {"Id": self.id}
        else:
            raise AssertionError("Unexpected Engine operation")

    def run(self, args, *, env=None, timeout=60):
        """Model fixed commands and execute phase effects on private test files."""
        if args[0] == "machinectl":
            return "456"
        if args[0] == "systemctl":
            if "-M" not in args:
                self.events.append("live-host-read")
                return "MainPID=999\nInvocationID=fixed\nNRestarts=0\nActiveState=active"
            if "stop" in args:
                self.events.append("host-stop")
                self.host_active = False
                return ""
            if "start" in args:
                self.events.append(self.current + "-host-start")
                self.host_active = True
                return ""
            if "MainPID" in args:
                return "0"
            if "Slice" in args:
                return "openkit-nanohost.slice"
            if "ExecStart" in args:
                return "/opt/published-nanohost"
            return "active" if self.host_active else "inactive"
        if args[0] == "systemd-run":
            if "import" in args:
                return self.input[self.current]["workerPlatformImage"]
            if args[-2:] == ["image", "list"]:
                self.events.append(self.current + "-previous-image-read")
                status = "incomplete" if self.downgrade_prior_image and self.current == "candidate" else "usable"
                return "digest=" + self.input["previous"]["workerPlatformImage"] + " size=9 status=" + status
            self.events.append("kernel-proof")
            return json.dumps({"positiveKernelObservation": True, "hostDomainEmpty": not self.bad_proof})
        phase = self.reader["Cmd"][-2] if args[0] == "docker" else args[-2]
        self.events.append(phase)
        if phase in ("fixtures", "operator-read-before", "operator-read"):
            assert args[0] == "node" and not self.host_active and not self.running
            assert "OPENKIT_UPGRADE_ADMIN_TOKEN" not in env
            assert "OPENKIT_UPGRADE_LOGIN_PASSWORD" not in env
        elif phase not in ("activate-before", "activate", "worker-before", "worker"):
            assert not self.host_active and not self.running
            assert self.reader["HostConfig"]["NetworkMode"] == "none"
        else:
            assert self.running and self.host_active
            assert args[0] == "nsenter" and "--pid" not in args
            assert env["OPENKIT_UPGRADE_ADMIN_TOKEN"] == "synthetic-token"
            assert "synthetic-token" not in " ".join(args)
        if phase == self.failed_worker:
            value = json.loads(Path(args[-1]).read_text())
            raise subprocess.CalledProcessError(1, args, stderr=json.dumps({
                "passed": False, "requestId": value["requestId"], "workspaceId": "synthetic-workspace",
                "threadId": "synthetic-thread", "turnId": "synthetic-turn", "cause": "PRIVATE secret unknown-effect",
            }))
        if phase == "fixtures":
            return json.dumps({"passed": True, "externalSelections": {
                "App update helper settings and receipts": ["external/retained-sample"],
                "Component update outcomes": ["external/retained-sample"],
            }})
        if phase == "seed":
            (Path(self.input["dataRoot"]) / "synthetic-corpus").write_text("retained")
            corpus = Path(self.input["retainedRoot"]) / "file-corpus"
            corpus.mkdir()
            (corpus / "protected-synthetic-vault").write_bytes(b"synthetic only")
        if phase == "worker-before":
            (Path(self.input["preparedLayout"]["privateRoot"]) / "external/native-volume").write_text("native-history")
        return json.dumps({"passed": True})

    def http(self, origin, path, body=None, token=None):
        """Return synthetic public reads and retained login identity."""
        if origin == self.input.get("liveDevOrigin"):
            self.events.append("live-health-read")
            assert path == "/api/health" and body is None and token is None
            return 200, {"status": "ok", "service": "nanocore"}
        if path == "/api/auth/sign-in/email":
            assert body["password"] == "synthetic-password"
            return 200, {"user": {"id": self.input["userId"]}}
        if path.endswith("diagnostics.app"):
            return 200, {"build": {"sourceCommit": self.input[self.current]["commit"]}}
        if path.endswith("nanohost.runtime-target"):
            return 200, {**self.input["expectedRuntime"], "ready": True, "freshEmpty": True,
                         "predecessorFenced": True, "connectionGeneration": 1}
        if path.endswith("app-update.preflight"):
            return 200, {"state": "idle", "counts": {"turns": 0}}
        return 200, {}


class LifecycleTests(unittest.TestCase):
    """Exercise actual orchestration with effect-boundary stand-ins."""

    def setUp(self):
        """Create a complete private prepared fixture, without any product process."""
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name)
        root = base / "prepared"
        root.mkdir(mode=0o700)
        guest = root / "guest"
        for path in (guest / "var/lib/openkit", guest / "etc/openkit", guest / "opt",
                     root / "data/config", root / "slots", root / "external", root / "payloads"):
            path.mkdir(parents=True)
            (path / "retained-sample").write_bytes(b"private complete state")
        previous = root / "payloads/previous"
        previous.write_bytes(b"previous-host")
        candidate = root / "payloads/candidate"
        candidate.write_bytes(b"candidate-host")
        installed = guest / "opt/published-nanohost"
        installed.write_bytes(previous.read_bytes())
        sha = lambda path: "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
        self.input = {
            "previous": {"tag": "v0.1.0-rc.9", "commit": "1" * 40, "appImage": "sha256:" + "1" * 64,
                         "workerImage": "sha256:" + "2" * 64, "nanoHost": sha(previous)},
            "candidate": {"commit": "2" * 40, "appImage": "sha256:" + "3" * 64,
                          "workerImage": "sha256:" + "4" * 64, "nanoHost": sha(candidate)},
            "checkout": str(Path(__file__).resolve().parents[1]), "appRoot": "/app/nanocore",
            "dataRoot": str(root / "data"), "retainedRoot": str(root / "result"),
            "externalRoot": str(root), "externalSelections": {
                "Host storage identity": ["guest/var/lib/openkit"],
                "Worker volume and native resume slots": ["slots"],
                "Execution image content and provenance": ["guest/var/lib/openkit"],
                "App update helper settings and receipts": ["external"],
                "Component update outcomes": ["external"],
            },
            "baseline": str(root / "result/baseline.json"), "userId": "synthetic-user",
            "origin": "http://127.0.0.1:18081", "agentId": "synthetic-agent", "modelId": "synthetic-model",
            "requestId": "synthetic-request", "expectedRuntime": {"identityId": "host", "deploymentId": "deployment"},
            "login": {"email": "synthetic@example.invalid", "userId": "synthetic-user"},
            "preparedLayout": {"privateRoot": str(root), "guestRoot": str(guest), "appContainer": "lrt-p14-upgrade",
                               "retainedPaths": [str(guest / "var/lib/openkit"), str(guest / "etc/openkit"),
                                                 str(root / "slots"), str(root / "external")],
                               "payloads": [{"installed": str(installed), "previous": str(previous),
                                             "candidate": str(candidate), "previousSha256": sha(previous),
                                             "candidateSha256": sha(candidate)}]},
        }
        for name in ("previous", "candidate"):
            self.input[name]["workerPlatformImage"] = self.input[name]["workerImage"]
            self.input[name + "WorkerArchive"] = "/opt/" + name + "-worker.tar"
            (guest / "opt" / (name + "-worker.tar")).write_bytes(b"prepared-archive")
        self.boundary = StandIn(self.input)
        self.addCleanup(patch.stopall)
        patch.object(DRIVER, "PRIVATE_BASE", base).start()
        patch.dict(os.environ, {"OPENKIT_UPGRADE_ADMIN_TOKEN": "synthetic-token",
                               "OPENKIT_UPGRADE_LOGIN_PASSWORD": "synthetic-password"}).start()

    def test_continuity_retains_whole_state_before_candidate_mutation(self):
        """Candidate mutation follows stopped baseline and complete retention."""
        self.input["liveDevOrigin"] = "http://127.0.0.1:9099"
        result = DRIVER.run_upgrade(self.input, self.boundary)
        self.assertTrue(result["passed"], result)
        events = self.boundary.events
        self.assertEqual([e for e in events if e in ("seed", "worker-before", "snapshot", "compare", "worker")],
                         ["seed", "worker-before", "snapshot", "compare", "worker"])
        self.assertLess(events.index("host-stop"), events.index("kernel-proof"))
        self.assertLess(events.index("kernel-proof"), events.index("app-stop"))
        self.assertLess(events.index("snapshot"), events.index("candidate-mutation"))
        self.assertEqual((Path(self.input["dataRoot"]) / "synthetic-corpus").read_text(), "retained")
        self.assertFalse(self.boundary.running)
        self.assertNotEqual(result["workers"]["worker-before"]["requestId"], result["workers"]["worker"]["requestId"])
        self.assertTrue(result["liveDevObservation"]["unchanged"])
        self.assertEqual(events.count("live-health-read"), 2)
        self.assertEqual(events.count("live-host-read"), 2)
        self.assertLess(events.index("live-host-read"), events.index("host-stop"))
        self.assertEqual(events[-2:], ["live-health-read", "live-host-read"])
        report = json.dumps(result)
        self.assertNotIn("synthetic-token", report)
        self.assertNotIn(self.input["dataRoot"], report)
        with self.assertRaises(FileExistsError):
            DRIVER.run_upgrade(self.input, self.boundary)

    def test_failed_kernel_proof_blocks_app_stop_and_seed(self):
        """A failed positive kernel proof never admits offline mutation."""
        self.boundary.bad_proof = True
        result = DRIVER.run_upgrade(self.input, self.boundary)
        self.assertFalse(result["passed"])
        self.assertEqual(self.boundary.events.count("kernel-proof"), 1)
        self.assertNotIn("app-stop", self.boundary.events)
        self.assertNotIn("seed", self.boundary.events)

    def test_failed_worker_preserves_unknown_effect_without_retry(self):
        """A failed candidate Worker cannot pass or replay its mutation."""
        self.boundary.failed_worker = "worker"
        result = DRIVER.run_upgrade(self.input, self.boundary)
        self.assertFalse(result["passed"])
        self.assertEqual(result["effect"], "unknown_until_inspected")
        self.assertEqual(self.boundary.events.count("worker"), 1)
        self.assertEqual(result["workers"]["worker"]["turnId"], "synthetic-turn")
        self.assertFalse(self.boundary.running)
        self.assertTrue((Path(self.input["retainedRoot"]) / "whole-state/recovery.json").exists())
        self.assertNotIn("PRIVATE", json.dumps(result))

    def test_candidate_reader_cannot_downgrade_previous_image_metadata(self):
        """Raw retained bytes cannot mask an unusable old image metadata entry."""
        self.boundary.downgrade_prior_image = True
        result = DRIVER.run_upgrade(self.input, self.boundary)
        self.assertFalse(result["passed"])
        self.assertIn("previous_reader_previous_image_usable", result["steps"])
        self.assertIn("candidate-previous-image-read", self.boundary.events)
        self.assertNotIn("candidate-app-start", self.boundary.events)
        self.assertNotIn("compare", self.boundary.events)


if __name__ == "__main__":
    unittest.main()
