"""Controlled-start tests use real files, injected manager facts and no live systemd."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "nanohost_maintenance", Path(__file__).with_name("nanohost-maintenance.py")
)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
# Missing production is a collection failure, never a skipped or passed behavior check.
SPEC.loader.exec_module(MODULE)

IDENTIFIER = "41830d22-d653-4838-ae3b-0ad78819b2fe"
BOOT = "3c62645e-b416-4dca-bdcf-38877ac09393"
UNIT = "openkit-nanohost.service"
UNIT_PATH = "/etc/systemd/system/" + UNIT
GUARD_DIR = UNIT_PATH + ".d"
GUARD = GUARD_DIR + "/zz-openkit-replacement-" + IDENTIFIER + ".conf"
PERMIT = "/run/openkit-replacement-" + IDENTIFIER + "/permit"
ATTEMPT = GUARD_DIR + "/.openkit-replacement-" + IDENTIFIER + ".attempted"
GUARD_BYTES = ("[Unit]\nConditionPathExists=" + PERMIT + "\n[Service]\nRestart=no\n"
               "ExecStartPre=/usr/bin/rm -- " + PERMIT + "\n").encode()
DOMAIN = "/sys/fs/cgroup/openkit.slice/openkit-nanohost.slice"
CGROUP = "/openkit.slice/openkit-nanohost.slice/openkit-nanohost.service"
LIVE = {"nanohost": ("/usr/lib/openkit/nanohost", 0o755),
        "gateway": ("/usr/lib/openkit/openshell-gateway", 0o755),
        "unit": (UNIT_PATH, 0o644)}
OLD_UNIT = b"[Service]\nExecStart=/usr/lib/openkit/nanohost\nRestart=always\n"
TARGET = {"nanohost": b"verified target nanohost\n", "gateway": b"verified target gateway\n",
          "unit": OLD_UNIT + b"Environment=TARGET_FIXTURE=1\n"}
STAMP = {"bootId": BOOT, "pid": 4412, "startTimeTicks": "1002098"}


def sha(data):
    """Fix payload expectations from independent fixture bytes."""
    return hashlib.sha256(data).hexdigest()


class Host:
    """Model only external observations and command effects in a disposable filesystem."""

    def __init__(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="maintenance-")
        self.root = Path(self.temporary.name)
        self.calls = []
        self.effects = []
        self.on_effect = None
        self.on_query = None
        self.start_error = False
        self.start_refusal = False
        self.loaded_unit = OLD_UNIT
        self.loaded_guard = None
        self.paths = ["/etc/systemd/system", "/run/systemd/system", "/usr/lib/systemd/system"]
        self.bus = {"UnitPath": {"type": "as", "data": self.paths},
                    "Job": {"type": "(uo)", "data": [0, "/"]},
                    "TriggeredBy": {"type": "as", "data": []}}
        self.facts = {"MainPID": "4400", "ActiveState": "active", "SubState": "running",
                      "ControlGroup": CGROUP, "Slice": "openkit-nanohost.slice",
                      "Restart": "always", "DropInPaths": "", "FragmentPath": UNIT_PATH,
                      "NeedDaemonReload": "no", "LoadState": "loaded"}
        for directory in self.paths:
            self.path(directory).mkdir(parents=True, exist_ok=True)
        self.write(UNIT_PATH, OLD_UNIT)
        self.write(LIVE["nanohost"][0], b"old nanohost", 0o755)
        self.write(LIVE["gateway"][0], b"old gateway", 0o755)
        self.write("/sys/fs/cgroup/cgroup.controllers", b"cpu memory pids\n")
        self.population(True)
        self.write("/proc/sys/kernel/random/boot_id", (BOOT + "\n").encode())
        self.process(4400, "1000000")
        self.process(STAMP["pid"], STAMP["startTimeTicks"])
        self.sentinels = {"/var/lib/openkit/nanohost/epoch": b"epoch outside payload scope",
                          "/var/lib/openkit/nanohost-work/history": b"retained native history",
                          "/etc/openkit/token-a": b"invented token fixture",
                          "/etc/openkit/token-b": b"",
                          "/etc/systemd/system/unrelated.service.d/operator.conf": b"other override",
                          GUARD_DIR + "/notes.txt": b"unknown non-drop-in file"}
        for path, data in self.sentinels.items():
            self.write(path, data, 0o600)
        self.sentinel_identities = {name: self.identity(self.path(name)) for name in self.sentinels}

    def __enter__(self):
        """Return this independently owned scenario."""
        return self

    def __exit__(self, *_args):
        """Remove only the scenario's private tree."""
        self.temporary.cleanup()

    def path(self, logical):
        """Map a fixed logical path into contained fixture storage."""
        return self.root / logical.lstrip("/")

    def write(self, logical, data, mode=0o644):
        """Create real bytes and explicit file metadata."""
        path = self.path(logical)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(mode)

    def process(self, pid, ticks):
        """Write Linux stat fields with a parenthesized process name and field-22 start ticks."""
        fields = ["S"] + ["0"] * 30
        fields[19] = ticks
        self.write("/proc/" + str(pid) + "/stat", (str(pid) + " (nano host (fixture)) " + " ".join(fields) + "\n").encode())
        self.write("/proc/" + str(pid) + "/cgroup", ("0::" + CGROUP + "\n").encode())

    def population(self, active, pid=4400, sibling=True):
        """Model service and sibling facts, including a sibling writer before maintenance."""
        for suffix in ("", "/" + UNIT, "/docker-fixture.scope"):
            populated = active and (suffix != "/docker-fixture.scope" or sibling)
            processes = b""
            if populated and suffix:
                processes = (str(pid if suffix == "/" + UNIT else 4440) + "\n").encode()
            self.write(DOMAIN + suffix + "/cgroup.events", b"populated 1\nfrozen 0\n" if populated else b"populated 0\nfrozen 0\n")
            self.write(DOMAIN + suffix + "/cgroup.procs", processes)

    @staticmethod
    def identity(path):
        """Ignore atime and preserve all stable identity, metadata and byte observations."""
        info = path.lstat()
        data = os.readlink(path) if stat.S_ISLNK(info.st_mode) else path.read_bytes() if stat.S_ISREG(info.st_mode) else None
        return (info.st_mode, info.st_uid, info.st_gid, info.st_ino, info.st_mtime_ns, data)

    def snapshot(self):
        """Inspect all fixture entries without following symlinks."""
        result = {}
        for parent, directories, files in os.walk(self.root, followlinks=False):
            for name in directories + files:
                path = Path(parent) / name
                result[str(path.relative_to(self.root))] = self.identity(path)
        return result

    def install_target(self):
        """Supply target bytes externally; this is not an installer substitute or qualification."""
        for key, (path, mode) in LIVE.items():
            self.write(path, TARGET[key], mode)

    def hashes(self):
        """Return verified fixture target identities independent of production constants."""
        return {key: sha(data) for key, data in TARGET.items()}

    def maintenance(self, replacement_id=IDENTIFIER):
        """Construct the actual procedure with only its command transport replaced."""
        return MODULE.Maintenance(replacement_id, root=self.root, run_command=self.run)

    def run(self, argv):
        """Answer fixed reads and mimic only the explicitly permitted supervisor effects."""
        argv = list(argv)
        self.calls.append(argv)
        if argv[0] == "/usr/bin/busctl":
            properties = [name for name in (*self.bus, "Conditions") if name in argv]
            if len(properties) != 1:
                raise AssertionError("unexpected D-Bus property")
            property_name = properties[0]
            manager = property_name == "UnitPath"
            expected = ["--system", "--json=short", "get-property", "org.freedesktop.systemd1",
                        "/org/freedesktop/systemd1" if manager else "/org/freedesktop/systemd1/unit/openkit_2dnanohost_2eservice",
                        "org.freedesktop.systemd1.Manager" if manager else "org.freedesktop.systemd1.Unit", property_name]
            if sorted(argv[1:]) != sorted(expected) or property_name not in (*self.bus, "Conditions"):
                raise AssertionError("unexpected D-Bus selector")
            if self.on_query:
                self.on_query(property_name)
            value = self.bus.get(property_name)
            if property_name == "Conditions":
                value = {"type": "a(sbbsi)", "data": [["ConditionPathExists", False, False, PERMIT, 0]] if self.loaded_guard else []}
            return subprocess.CompletedProcess(argv, 0, json.dumps(value).encode() + b"\n", b"")
        if argv[0] != "/usr/bin/systemctl":
            raise AssertionError("unexpected command executable")
        args = argv[1:]
        if "show" in args:
            selected, positional = [], []
            iterator = iter(args)
            for token in iterator:
                if token in ("-p", "--property"):
                    selected.extend(next(iterator).split(","))
                elif token.startswith("--property="):
                    selected.extend(token.split("=", 1)[1].split(","))
                elif token not in ("--no-pager", "--all", "--plain"):
                    positional.append(token)
            if sorted(positional) != [UNIT, "show"] or any(key not in self.facts for key in selected):
                raise AssertionError("unexpected service query")
            if self.on_query:
                self.on_query("show")
            unit_bytes = self.path(UNIT_PATH).read_bytes() if self.path(UNIT_PATH).is_file() else None
            guard_bytes = self.path(GUARD).read_bytes() if self.path(GUARD).is_file() else None
            facts = dict(self.facts)
            facts["NeedDaemonReload"] = "yes" if (unit_bytes, guard_bytes) != (self.loaded_unit, self.loaded_guard) else facts["NeedDaemonReload"]
            return subprocess.CompletedProcess(argv, 0, "".join(key + "=" + facts[key] + "\n" for key in selected or facts).encode(), b"")
        effect = tuple(token for token in args if token != "--no-pager")
        if effect not in (("daemon-reload",), ("stop", UNIT), ("stop", "openkit-nanohost.slice"), ("start", UNIT)):
            raise AssertionError("unexpected lifecycle selector")
        self.effects.append(effect)
        if self.on_effect:
            self.on_effect(effect)
        if effect == ("daemon-reload",):
            self.loaded_unit = self.path(UNIT_PATH).read_bytes()
            self.loaded_guard = self.path(GUARD).read_bytes() if self.path(GUARD).exists() else None
            self.facts["DropInPaths"] = GUARD if self.loaded_guard else ""
            self.facts["Restart"] = "no" if self.loaded_guard else "always"
            self.facts["NeedDaemonReload"] = "no"
        elif effect[0] == "stop":
            self.facts.update(MainPID="0", ActiveState="inactive", SubState="dead")
            if effect[1] == "openkit-nanohost.slice":
                self.population(False)
            else:
                self.write(DOMAIN + "/" + UNIT + "/cgroup.events", b"populated 0\nfrozen 0\n")
                self.write(DOMAIN + "/" + UNIT + "/cgroup.procs", b"")
        else:
            if self.loaded_guard != GUARD_BYTES or not self.path(PERMIT).exists():
                raise AssertionError("start lacks the exact effective consuming guard or permit")
            if self.loaded_unit != TARGET["unit"]:
                raise AssertionError("target unit was not reloaded while inhibited")
            if self.start_refusal:
                return subprocess.CompletedProcess(argv, 1, b"", b"invented-private-marker")
            # This is the external manager's modeled ExecStartPre effect, not production cleanup.
            self.path(PERMIT).unlink()
            self.facts.update(MainPID=str(STAMP["pid"]), ActiveState="active", SubState="running")
            self.population(True, pid=STAMP["pid"], sibling=False)
            if self.start_error:
                raise OSError(5, "invented-private-marker", "/private/unknown-start")
        return subprocess.CompletedProcess(argv, 0, b"", b"")


class LifecycleTests(unittest.TestCase):
    """Use prior observable safety predicates without prescribing implementation helpers."""

    def assert_sentinels(self, host):
        """Require exact preservation of unrelated configuration, credentials and retained data."""
        for name, identity in host.sentinel_identities.items():
            self.assertEqual(host.identity(host.path(name)), identity, name)

    def refusal(self, host, operation):
        """Require a bounded non-secret refusal without accepting raw OS details."""
        with self.assertRaises(Exception) as caught:
            operation()
        message = str(caught.exception)
        self.assertTrue(message)
        self.assertLessEqual(len(message), 256)
        self.assertNotIn(str(host.root), message)
        self.assertNotIn("invented-private-marker", message)
        self.assertNotIn("/private/", message)
        self.assert_sentinels(host)
        return message

    def prepared(self, host):
        """Execute real begin, then supply an externally installed complete target set."""
        host.maintenance().begin(sha(OLD_UNIT))
        host.install_target()

    def test_constructor_has_no_file_or_command_effect(self):
        """A constructor does not acquire maintenance authority."""
        with Host() as host:
            before = host.snapshot()
            host.maintenance()
            self.assertEqual(host.calls, [])
            self.assertEqual(host.snapshot(), before)

    def test_invalid_identifiers_and_old_hashes_refuse_before_effects(self):
        """Malformed authority-bearing inputs cannot select operation paths or old payloads."""
        for identifier in (None, [], 17, "../outside", IDENTIFIER.upper(), "41830d22", ""):
            with self.subTest(identifier=identifier), Host() as host:
                before = host.snapshot()
                self.refusal(host, lambda: host.maintenance(identifier).begin(sha(OLD_UNIT)))
                self.assertEqual(host.effects, [])
                self.assertEqual(host.snapshot(), before)
        for old_hash in (None, {}, 17, True, b"f" * 64, "A" * 64, "g" * 64, "f" * 63):
            with self.subTest(old_hash=old_hash), Host() as host:
                before = host.snapshot()
                self.refusal(host, lambda: host.maintenance().begin(old_hash))
                self.assertEqual(host.effects, [])
                self.assertEqual(host.snapshot(), before)

    def test_target_hash_objects_are_closed_and_strict_before_start_or_finalize(self):
        """Unknown keys, missing hashes and coerced values cannot authorize either stage."""
        valid = {key: sha(data) for key, data in TARGET.items()}
        variants = [None, [], {}, {**valid, "command": "forbidden"}]
        for value in (None, True, 17, "A" * 64, "g" * 64, "f" * 63):
            variants.append({**valid, "gateway": value})
        missing = dict(valid)
        del missing["unit"]
        variants.append(missing)
        for stage in ("start", "finalize"):
            for hashes in variants:
                with self.subTest(stage=stage, hashes=hashes), Host() as host:
                    self.prepared(host)
                    if stage == "finalize":
                        host.maintenance().start_once(host.hashes())
                    before = host.snapshot()
                    effects = list(host.effects)
                    operation = (lambda: host.maintenance().start_once(hashes)) if stage == "start" else (lambda: host.maintenance().finalize(dict(STAMP), hashes))
                    self.refusal(host, operation)
                    self.assertEqual(host.snapshot(), before)
                    self.assertEqual(host.effects, effects)

    def test_incarnation_object_is_closed_and_never_coerced(self):
        """Finalization requires a complete native process witness with strict field types."""
        variants = [None, [], {}, {**STAMP, "start": "forbidden"}]
        for key, value in (("bootId", "not-a-uuid"), ("pid", True), ("pid", 0),
                           ("pid", str(STAMP["pid"])), ("startTimeTicks", 1002098),
                           ("startTimeTicks", "0"), ("startTimeTicks", "-1")):
            variants.append({**STAMP, key: value})
        for stamp in variants:
            with self.subTest(stamp=stamp), Host() as host:
                self.prepared(host)
                host.maintenance().start_once(host.hashes())
                before = host.snapshot()
                effects = list(host.effects)
                self.refusal(host, lambda: host.maintenance().finalize(stamp, host.hashes()))
                self.assertEqual(host.snapshot(), before)
                self.assertEqual(host.effects, effects)

    def test_unsafe_manager_unit_roots_refuse_before_any_local_or_supervisor_effect(self):
        """Actual UnitPath does not authorize escaping containment or adopting writable config."""
        for kind in ("relative", "traversal", "file", "symlink-loop", "symlink-escape", "group-writable-parent"):
            with self.subTest(kind=kind), Host() as host, tempfile.TemporaryDirectory(prefix="manager-outside-") as outside:
                selected = host.path("/opt/extra-units")
                selected.parent.mkdir(parents=True, exist_ok=True)
                logical = "/opt/extra-units"
                if kind == "relative":
                    logical = "relative/extra-units"
                elif kind == "traversal":
                    logical = "/../../outside-units"
                elif kind == "file":
                    selected.write_bytes(b"not a directory")
                elif kind == "symlink-loop":
                    selected.symlink_to(selected.name)
                elif kind == "symlink-escape":
                    selected.symlink_to(os.path.relpath(outside, selected.parent), target_is_directory=True)
                else:
                    selected.mkdir()
                    selected.parent.chmod(0o775)
                host.paths.append(logical)
                outside_sentinel = Path(outside) / "keep"
                outside_sentinel.write_bytes(b"outside fixture authority")
                outside_before = Host.identity(outside_sentinel)
                before = host.snapshot()
                self.refusal(host, lambda: host.maintenance().begin(sha(OLD_UNIT)))
                self.assertEqual(host.effects, [])
                self.assertEqual(host.snapshot(), before)
                self.assertEqual(Host.identity(outside_sentinel), outside_before)

    def test_wrong_payload_metadata_refuses_without_repair(self):
        """Hash equality cannot authorize a wrong-mode old unit or target program."""
        for stage in ("begin", "start", "finalize"):
            with self.subTest(stage=stage), Host() as host:
                if stage != "begin":
                    self.prepared(host)
                if stage == "finalize":
                    host.maintenance().start_once(host.hashes())
                target = host.path(UNIT_PATH if stage == "begin" else LIVE["gateway"][0])
                target.chmod(0o600)
                before = host.snapshot()
                effects = list(host.effects)
                if stage == "begin":
                    operation = lambda: host.maintenance().begin(sha(OLD_UNIT))
                elif stage == "start":
                    operation = lambda: host.maintenance().start_once(host.hashes())
                else:
                    operation = lambda: host.maintenance().finalize(dict(STAMP), host.hashes())
                self.refusal(host, operation)
                self.assertEqual(host.snapshot(), before)
                self.assertEqual(host.effects, effects)

    def test_foreign_owner_observation_cannot_authorize_any_stage(self):
        """Inject an ineligible caller principal against real unchanged fixture ownership."""
        for stage in ("begin", "start", "finalize"):
            with self.subTest(stage=stage), Host() as host:
                if stage != "begin":
                    self.prepared(host)
                if stage == "finalize":
                    host.maintenance().start_once(host.hashes())
                before = host.snapshot()
                effects = list(host.effects)
                if stage == "begin":
                    operation = lambda: host.maintenance().begin(sha(OLD_UNIT))
                elif stage == "start":
                    operation = lambda: host.maintenance().start_once(host.hashes())
                else:
                    operation = lambda: host.maintenance().finalize(dict(STAMP), host.hashes())
                with mock.patch.object(os, "geteuid", return_value=os.geteuid() + 1):
                    self.refusal(host, operation)
                self.assertEqual(host.snapshot(), before)
                self.assertEqual(host.effects, effects)

    def test_begin_durably_guards_before_reload_and_both_stops(self):
        """The persistent consuming guard precedes every supervisor lifecycle effect."""
        with Host() as host:
            synced = set()
            original_fsync = os.fsync
            def sync(fd):
                original_fsync(fd)
                info = os.fstat(fd)
                synced.add((info.st_dev, info.st_ino))
            def check(_effect):
                self.assertEqual(host.path(GUARD).read_bytes(), GUARD_BYTES)
                for path in (host.path(GUARD), host.path(GUARD).parent):
                    info = path.stat()
                    self.assertIn((info.st_dev, info.st_ino), synced)
                self.assertFalse(host.path(PERMIT).exists())
            host.on_effect = check
            with mock.patch.object(os, "fsync", side_effect=sync):
                host.maintenance().begin(sha(OLD_UNIT))
            self.assertEqual(stat.S_IMODE(host.path(GUARD).stat().st_mode), 0o644)
            self.assertIn(("stop", UNIT), host.effects)
            self.assertIn(("stop", "openkit-nanohost.slice"), host.effects)
            self.assertNotIn(("start", UNIT), host.effects)
            self.assertEqual(host.facts["MainPID"], "0")
            self.assertEqual(host.path(DOMAIN + "/docker-fixture.scope/cgroup.events").read_bytes(), b"populated 0\nfrozen 0\n")
            self.assert_sentinels(host)

    def test_unsupported_begin_facts_and_occupied_names_refuse_before_effects(self):
        """Admission cannot create its own prerequisite or resume previous custody."""
        for kind in ("wrong-old-hash", "inactive", "pending-job", "trigger", "guard", "attempt", "permit", "pending-reload", "fragment", "loaded-dropin"):
            with self.subTest(kind=kind), Host() as host:
                old_hash = sha(OLD_UNIT)
                if kind == "wrong-old-hash": old_hash = "f" * 64
                elif kind == "inactive": host.facts.update(MainPID="0", ActiveState="inactive", SubState="dead")
                elif kind == "pending-job": host.bus["Job"]["data"] = [17, "/org/freedesktop/systemd1/job/17"]
                elif kind == "trigger": host.bus["TriggeredBy"]["data"] = ["fixture.timer"]
                elif kind in ("guard", "attempt", "permit"):
                    host.write({"guard": GUARD, "attempt": ATTEMPT, "permit": PERMIT}[kind], GUARD_BYTES if kind == "guard" else b"")
                elif kind == "pending-reload": host.facts["NeedDaemonReload"] = "yes"
                elif kind == "fragment": host.facts["FragmentPath"] = "/run/systemd/system/" + UNIT
                else: host.facts["DropInPaths"] = "/etc/systemd/system/service.d/foreign.conf"
                before = host.snapshot()
                self.refusal(host, lambda: host.maintenance().begin(old_hash))
                self.assertEqual(host.effects, [])
                self.assertEqual(host.snapshot(), before)

    def test_actual_manager_roots_and_prefix_dropins_are_inspected(self):
        """An extra manager-selected root cannot hide an unsupported applicable override."""
        for directory in (UNIT + ".d", "openkit-.service.d", "service.d"):
            with self.subTest(directory=directory), Host() as host:
                host.paths.append("/opt/fixture-units")
                host.write("/opt/fixture-units/" + directory + "/foreign.conf", b"[Service]\nRestart=always\n")
                before = host.snapshot()
                self.refusal(host, lambda: host.maintenance().begin(sha(OLD_UNIT)))
                self.assertEqual(host.effects, [])
                self.assertEqual(host.snapshot(), before)

    def test_safe_distro_unit_path_symlink_does_not_escape_fixture(self):
        """The actual manager may report a standard alias of an already inspected unit root."""
        with Host() as host:
            host.path("/lib").symlink_to("usr/lib", target_is_directory=True)
            host.paths.append("/lib/systemd/system")
            host.maintenance().begin(sha(OLD_UNIT))
            self.assertEqual(host.path(GUARD).read_bytes(), GUARD_BYTES)
            self.assert_sentinels(host)

    def test_malformed_typed_activation_facts_refuse_before_writes(self):
        """A manager result must prove exact no-job, no-trigger and bounded load roots."""
        for key, value in (("UnitPath", {"type": "as", "data": []}),
                           ("UnitPath", {"type": "s", "data": "/etc/systemd/system"}),
                           ("Job", {"type": "(uo)", "data": [0, "/other"]}),
                           ("Job", {"type": "(uo)", "data": [False, "/"]}),
                           ("TriggeredBy", {"type": "as", "data": None})):
            with self.subTest(key=key, value=value), Host() as host:
                host.bus[key] = value
                before = host.snapshot()
                self.refusal(host, lambda: host.maintenance().begin(sha(OLD_UNIT)))
                self.assertEqual(host.effects, [])
                self.assertEqual(host.snapshot(), before)

    def test_guard_fsync_failure_issues_no_lifecycle_and_keeps_retained_inputs(self):
        """A failed guard durability boundary does not authorize reload or stop."""
        with Host() as host:
            with mock.patch.object(os, "fsync", side_effect=OSError(5, "invented-private-marker", "/private/guard")):
                self.refusal(host, lambda: host.maintenance().begin(sha(OLD_UNIT)))
            self.assertEqual(host.effects, [])

    def test_admission_command_failures_never_create_guard_or_issue_lifecycle(self):
        """Unavailable manager observations cannot become an admitted stopped procedure."""
        for query in ("show", "UnitPath", "Job", "TriggeredBy"):
            for kind in ("nonzero", "malformed", "exception"):
                with self.subTest(query=query, kind=kind), Host() as host:
                    original = host.run
                    def run(argv):
                        if query in argv:
                            if kind == "exception":
                                raise OSError(5, "invented-private-marker", "/private/query")
                            return subprocess.CompletedProcess(argv, 1 if kind == "nonzero" else 0,
                                                               b"invalid fact envelope", b"invented-private-marker" if kind == "nonzero" else b"")
                        return original(argv)
                    before = host.snapshot()
                    self.refusal(host, lambda: MODULE.Maintenance(IDENTIFIER, root=host.root, run_command=run).begin(sha(OLD_UNIT)))
                    self.assertEqual(host.effects, [])
                    self.assertEqual(host.snapshot(), before)

    def test_unknown_begin_effect_keeps_guard_and_does_not_reenter(self):
        """A lost reload or stop result preserves inhibition without repeating maintenance."""
        for failed in (("daemon-reload",), ("stop", UNIT), ("stop", "openkit-nanohost.slice")):
            with self.subTest(failed=failed), Host() as host:
                original = host.run
                def run(argv):
                    result = original(argv)
                    if tuple(token for token in argv[1:] if token != "--no-pager") == failed:
                        raise OSError(5, "invented-private-marker", "/private/begin-effect")
                    return result
                self.refusal(host, lambda: MODULE.Maintenance(IDENTIFIER, root=host.root, run_command=run).begin(sha(OLD_UNIT)))
                self.assertEqual(host.path(GUARD).read_bytes(), GUARD_BYTES)
                effects = list(host.effects)
                self.refusal(host, lambda: host.maintenance().begin(sha(OLD_UNIT)))
                self.assertEqual(host.effects, effects)
                self.assertEqual(host.effects.count(failed), 1)
                self.assertNotIn(("start", UNIT), host.effects)

    def test_persistent_attempt_is_synced_before_volatile_permit_and_start(self):
        """A private volatile permit follows durable attempt custody, not a reboot claim."""
        with Host() as host:
            self.prepared(host)
            original_fsync = os.fsync
            persisted = set()
            parent = host.path(ATTEMPT).parent.stat()
            parent_identity = (parent.st_dev, parent.st_ino)
            def sync(fd):
                info = os.fstat(fd)
                identity = (info.st_dev, info.st_ino)
                if host.path(ATTEMPT).exists():
                    attempt = host.path(ATTEMPT).stat()
                    attempt_identity = (attempt.st_dev, attempt.st_ino)
                    if identity in (attempt_identity, parent_identity) and identity not in persisted:
                        self.assertFalse(os.path.lexists(host.path(PERMIT)), "first attempt durability boundary must precede permit publication")
                        original_fsync(fd)
                        persisted.add(identity)
                        return
                original_fsync(fd)
            def check(effect):
                if effect != ("start", UNIT):
                    return
                attempt = host.path(ATTEMPT).stat()
                self.assertIn((attempt.st_dev, attempt.st_ino), persisted)
                self.assertIn(parent_identity, persisted)
                permit = host.path(PERMIT).lstat()
                directory = host.path(PERMIT).parent.lstat()
                self.assertTrue(stat.S_ISREG(permit.st_mode))
                self.assertEqual((permit.st_uid, permit.st_gid), (os.geteuid(), os.getegid()))
                self.assertTrue(stat.S_ISDIR(directory.st_mode))
                self.assertEqual(stat.S_IMODE(directory.st_mode), 0o700)
                self.assertEqual((directory.st_uid, directory.st_gid), (os.geteuid(), os.getegid()))
                for key, (logical, mode) in LIVE.items():
                    self.assertEqual(host.path(logical).read_bytes(), TARGET[key])
                    self.assertEqual(stat.S_IMODE(host.path(logical).stat().st_mode), mode)
            host.on_effect = check
            with mock.patch.object(os, "fsync", side_effect=sync):
                self.assertEqual(host.maintenance().start_once(host.hashes()), STAMP)
            self.assertFalse(os.path.lexists(host.path(PERMIT)))
            self.assert_sentinels(host)

    def test_known_unconsumed_start_failure_removes_only_its_permit_and_never_repeats(self):
        """A known rejected start cannot leave a permit for a later activation source."""
        with Host() as host:
            self.prepared(host)
            host.start_refusal = True
            self.refusal(host, lambda: host.maintenance().start_once(host.hashes()))
            self.assertFalse(os.path.lexists(host.path(PERMIT)))
            attempt = host.identity(host.path(ATTEMPT))
            guard = host.identity(host.path(GUARD))
            self.refusal(host, lambda: host.maintenance().start_once(host.hashes()))
            self.assertEqual(host.effects.count(("start", UNIT)), 1)
            self.assertEqual(host.identity(host.path(ATTEMPT)), attempt)
            self.assertEqual(host.identity(host.path(GUARD)), guard)

    def test_rejected_start_never_deletes_a_changed_or_substituted_permit(self):
        """A failed command grants no cleanup authority over an unexpected appearing path."""
        for kind in ("changed", "symlink"):
            with self.subTest(kind=kind), Host() as host:
                self.prepared(host)
                host.start_refusal = True
                appeared = []
                outside = host.path("/outside-permit")
                outside.write_bytes(b"unrelated permit target")
                outside_before = host.identity(outside)
                def replace(effect):
                    if effect != ("start", UNIT):
                        return
                    permit = host.path(PERMIT)
                    permit.unlink()
                    if kind == "changed":
                        permit.write_bytes(b"unexpected appearing permit")
                    else:
                        permit.symlink_to(outside)
                    appeared.append(host.identity(permit))
                host.on_effect = replace
                self.refusal(host, lambda: host.maintenance().start_once(host.hashes()))
                self.assertTrue(appeared, "fault must occur after real permit publication")
                self.assertEqual(host.identity(host.path(PERMIT)), appeared[0])
                self.assertEqual(host.identity(outside), outside_before)
                self.assertEqual(host.path(GUARD).read_bytes(), GUARD_BYTES)
                self.assertTrue(host.path(ATTEMPT).is_file())
                host.on_effect = None
                self.refusal(host, lambda: host.maintenance().start_once(host.hashes()))
                self.assertEqual(host.effects.count(("start", UNIT)), 1)

    def test_target_substitution_at_loaded_target_query_blocks_permit_and_start(self):
        """A target hash measured before reload cannot authorize changed live bytes afterward."""
        for kind in ("bytes", "symlink"):
            with self.subTest(kind=kind), Host() as host:
                self.prepared(host)
                changed = []
                def replace(query):
                    if query != "show" or host.loaded_unit != TARGET["unit"] or changed:
                        return
                    gateway = host.path(LIVE["gateway"][0])
                    if kind == "bytes":
                        gateway.write_bytes(b"changed after target measurement")
                    else:
                        gateway.rename(gateway.with_name("appearing-gateway"))
                        gateway.symlink_to("appearing-gateway")
                    changed.append(host.identity(gateway))
                host.on_query = replace
                self.refusal(host, lambda: host.maintenance().start_once(host.hashes()))
                self.assertTrue(changed, "fault must occur at a loaded-target observation")
                self.assertEqual(host.identity(host.path(LIVE["gateway"][0])), changed[0])
                self.assertNotIn(("start", UNIT), host.effects)
                self.assertFalse(os.path.lexists(host.path(PERMIT)))

    def test_unavailable_proc_identity_blocks_finalization_without_guard_removal(self):
        """Missing or malformed actual process observations never become the supplied stamp."""
        for kind in ("missing-stat", "malformed-stat", "missing-boot", "malformed-boot"):
            with self.subTest(kind=kind), Host() as host:
                self.prepared(host)
                host.maintenance().start_once(host.hashes())
                target = host.path("/proc/" + str(STAMP["pid"]) + "/stat" if kind.endswith("stat") else "/proc/sys/kernel/random/boot_id")
                if kind.startswith("missing"):
                    target.unlink()
                else:
                    target.write_bytes(b"malformed observed identity\n")
                before = host.snapshot()
                effects = list(host.effects)
                self.refusal(host, lambda: host.maintenance().finalize(dict(STAMP), host.hashes()))
                self.assertEqual(host.snapshot(), before)
                self.assertEqual(host.effects, effects)

    def test_lost_final_reload_is_unknown_without_start_or_automatic_guard_restoration(self):
        """Finalization cannot report success or repeat start after an uncertain reload handoff."""
        with Host() as host:
            self.prepared(host)
            host.maintenance().start_once(host.hashes())
            attempt = host.identity(host.path(ATTEMPT))
            payloads = {key: host.identity(host.path(path)) for key, (path, _mode) in LIVE.items()}
            original = host.run
            failed = []
            def run(argv):
                result = original(argv)
                if "daemon-reload" in argv and not host.path(GUARD).exists():
                    failed.append(True)
                    raise OSError(5, "invented-private-marker", "/private/final-reload")
                return result
            self.refusal(host, lambda: MODULE.Maintenance(IDENTIFIER, root=host.root, run_command=run).finalize(dict(STAMP), host.hashes()))
            self.assertTrue(failed, "fault must follow actual final guard removal and reload")
            self.assertFalse(os.path.lexists(host.path(GUARD)))
            self.assertEqual(host.identity(host.path(ATTEMPT)), attempt)
            self.assertEqual({key: host.identity(host.path(path)) for key, (path, _mode) in LIVE.items()}, payloads)
            self.assertEqual(host.effects.count(("start", UNIT)), 1)

    def test_complete_start_consumes_permit_and_returns_actual_incarnation(self):
        """One start follows target reload and leaves persistent inhibition with consumed permit."""
        with Host() as host:
            self.prepared(host)
            actual = host.maintenance().start_once(host.hashes())
            self.assertEqual(actual, STAMP)
            self.assertEqual(host.effects.count(("start", UNIT)), 1)
            self.assertTrue(host.path(ATTEMPT).is_file())
            self.assertFalse(os.path.lexists(host.path(PERMIT)))
            self.assertEqual(host.path(GUARD).read_bytes(), GUARD_BYTES)
            self.assert_sentinels(host)

    def test_partial_changed_or_symlink_target_cannot_publish_start_permit(self):
        """The complete fixed payload set must remain verified before the one start."""
        for kind in ("missing", "changed", "mode", "symlink"):
            with self.subTest(kind=kind), Host() as host:
                self.prepared(host)
                unit = host.path(UNIT_PATH)
                if kind == "missing": unit.unlink()
                elif kind == "changed": unit.write_bytes(b"unexpected unit")
                elif kind == "mode": unit.chmod(0o600)
                else:
                    unit.rename(unit.with_name("foreign-unit"))
                    unit.symlink_to("foreign-unit")
                before = host.snapshot()
                self.refusal(host, lambda: host.maintenance().start_once(host.hashes()))
                self.assertNotIn(("start", UNIT), host.effects)
                self.assertFalse(os.path.lexists(host.path(PERMIT)))
                self.assertEqual(host.snapshot(), before)

    def test_new_sibling_after_target_reload_blocks_start(self):
        """A pre-reload empty snapshot cannot authorize permit publication after a writer appears."""
        with Host() as host:
            self.prepared(host)
            injected = []
            def change(effect):
                if effect == ("daemon-reload",):
                    host.write(DOMAIN + "/appearing.scope/cgroup.events", b"populated 1\nfrozen 0\n")
                    host.write(DOMAIN + "/appearing.scope/cgroup.procs", b"4712\n")
                    injected.append(True)
            host.on_effect = change
            self.refusal(host, lambda: host.maintenance().start_once(host.hashes()))
            self.assertTrue(injected)
            self.assertNotIn(("start", UNIT), host.effects)
            self.assertFalse(os.path.lexists(host.path(PERMIT)))
            self.assertEqual(host.path(GUARD).read_bytes(), GUARD_BYTES)

    def test_attempt_is_durable_before_permit_and_failure_does_not_start(self):
        """A fault at attempt persistence cannot leave a start-capable permit."""
        with Host() as host:
            self.prepared(host)
            original_fsync = os.fsync
            injected = []
            def fail_attempt(fd):
                if host.path(ATTEMPT).exists():
                    info = os.fstat(fd)
                    attempt = host.path(ATTEMPT).stat()
                    if (info.st_dev, info.st_ino) == (attempt.st_dev, attempt.st_ino):
                        self.assertFalse(os.path.lexists(host.path(PERMIT)))
                        injected.append(True)
                        raise OSError(5, "invented-private-marker", "/private/attempt")
                original_fsync(fd)
            with mock.patch.object(os, "fsync", side_effect=fail_attempt):
                self.refusal(host, lambda: host.maintenance().start_once(host.hashes()))
            self.assertTrue(injected, "fault must reach persistence of a real attempt file")
            self.assertTrue(host.path(ATTEMPT).is_file())
            self.assertFalse(os.path.lexists(host.path(PERMIT)))
            self.assertNotIn(("start", UNIT), host.effects)
            self.assertEqual(host.path(GUARD).read_bytes(), GUARD_BYTES)

    def test_lost_start_response_preserves_attempt_and_cannot_start_twice(self):
        """An actual external start followed by transport loss is unknown, not retry authority."""
        with Host() as host:
            self.prepared(host)
            host.start_error = True
            self.refusal(host, lambda: host.maintenance().start_once(host.hashes()))
            attempt = host.identity(host.path(ATTEMPT))
            self.refusal(host, lambda: host.maintenance().start_once(host.hashes()))
            self.assertEqual(host.effects.count(("start", UNIT)), 1)
            self.assertEqual(host.identity(host.path(ATTEMPT)), attempt)
            self.assertEqual(host.path(GUARD).read_bytes(), GUARD_BYTES)
            self.assertFalse(os.path.lexists(host.path(PERMIT)))

    def test_fresh_finalizer_restores_supervision_for_same_actual_process(self):
        """Independent process identity and complete hashes authorize only guard removal and reload."""
        with Host() as host:
            self.prepared(host)
            host.maintenance().start_once(host.hashes())
            attempt = host.identity(host.path(ATTEMPT))
            payloads = {key: host.identity(host.path(path)) for key, (path, _mode) in LIVE.items()}
            proc = host.identity(host.path("/proc/" + str(STAMP["pid"]) + "/stat"))
            boot = host.identity(host.path("/proc/sys/kernel/random/boot_id"))
            host.maintenance().finalize(dict(STAMP), host.hashes())
            self.assertFalse(os.path.lexists(host.path(GUARD)))
            self.assertFalse(os.path.lexists(host.path(PERMIT)))
            self.assertEqual(host.identity(host.path(ATTEMPT)), attempt)
            self.assertEqual(host.facts["Restart"], "always")
            self.assertEqual(host.facts["MainPID"], str(STAMP["pid"]))
            self.assertEqual(host.effects.count(("start", UNIT)), 1)
            self.assertEqual({key: host.identity(host.path(path)) for key, (path, _mode) in LIVE.items()}, payloads)
            self.assertEqual(host.identity(host.path("/proc/" + str(STAMP["pid"]) + "/stat")), proc)
            self.assertEqual(host.identity(host.path("/proc/sys/kernel/random/boot_id")), boot)
            self.assert_sentinels(host)

    def test_finalizer_rejects_changed_process_payload_or_guard_before_removal(self):
        """A stamp assertion cannot replace current process, payload or exact guard evidence."""
        for kind in ("boot", "pid", "ticks", "payload", "guard", "permit"):
            with self.subTest(kind=kind), Host() as host:
                self.prepared(host)
                host.maintenance().start_once(host.hashes())
                expected = dict(STAMP)
                if kind == "boot": expected["bootId"] = IDENTIFIER
                elif kind == "pid": expected["pid"] += 1
                elif kind == "ticks": host.process(STAMP["pid"], "1002099")
                elif kind == "payload": host.path(LIVE["gateway"][0]).write_bytes(b"changed payload")
                elif kind == "guard": host.path(GUARD).write_bytes(GUARD_BYTES + b"# unexpected edit\n")
                else: host.write(PERMIT, b"")
                before = host.snapshot()
                effects = list(host.effects)
                self.refusal(host, lambda: host.maintenance().finalize(expected, host.hashes()))
                self.assertEqual(host.snapshot(), before)
                self.assertEqual(host.effects, effects)

    def test_process_change_during_final_reload_is_not_success_or_another_start(self):
        """The same PID with different start ticks after reload is a different incarnation."""
        with Host() as host:
            self.prepared(host)
            host.maintenance().start_once(host.hashes())
            def change(effect):
                if effect == ("daemon-reload",) and not host.path(GUARD).exists():
                    host.process(STAMP["pid"], "1002100")
            host.on_effect = change
            self.refusal(host, lambda: host.maintenance().finalize(dict(STAMP), host.hashes()))
            self.assertEqual(host.effects.count(("start", UNIT)), 1)
            self.assertTrue(host.path(ATTEMPT).is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
