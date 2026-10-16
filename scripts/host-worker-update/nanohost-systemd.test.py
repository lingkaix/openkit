"""Read-only safety checks use real files and command facts, not a simulated systemd."""

import builtins
import copy
from contextlib import ExitStack
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


HELPER = Path(__file__).with_name("nanohost-systemd.py")
SPEC = importlib.util.spec_from_file_location("nanohost_systemd", HELPER)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
# An absent implementation fails collection. It is never a skipped or passed qualification.
SPEC.loader.exec_module(MODULE)

REPLACEMENT_ID = "41830d22-d653-4838-ae3b-0ad78819b2fe"
UNIT = "openkit-nanohost.service"
UNIT_PATH = "/etc/systemd/system/" + UNIT
GUARD_DIRECTORY = UNIT_PATH + ".d"
GUARD = GUARD_DIRECTORY + "/zz-openkit-replacement-" + REPLACEMENT_ID + ".conf"
PERMIT = "/run/openkit-replacement-" + REPLACEMENT_ID + "/permit"
GUARD_BYTES = (
    "[Unit]\nConditionPathExists=" + PERMIT + "\n[Service]\nRestart=no\n"
    "ExecStartPre=/usr/bin/rm -- " + PERMIT + "\n"
).encode()
DOMAIN = "/sys/fs/cgroup/openkit.slice/openkit-nanohost.slice"
CONTROL_GROUP = "/openkit.slice/openkit-nanohost.slice/openkit-nanohost.service"
CONDITION = {"type": "a(sbbsi)", "data": [["ConditionPathExists", False, False, PERMIT, 0]]}


class Fixture:
    """Own disposable files and explicit external observations for one independent scenario."""

    def __init__(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="systemd-facts-")
        self.root = Path(self.temporary.name)
        self.calls = []
        self.show_count = 0
        self.condition_count = 0
        self.on_command = None
        self.result_override = None
        self.facts = {
            "MainPID": "0", "ActiveState": "inactive", "SubState": "dead",
            "ControlGroup": CONTROL_GROUP, "Slice": "openkit-nanohost.slice",
            "Restart": "no", "DropInPaths": GUARD, "FragmentPath": UNIT_PATH,
            "NeedDaemonReload": "no", "LoadState": "loaded",
        }
        self.conditions = copy.deepcopy(CONDITION)
        self.write(UNIT_PATH, b"[Service]\nExecStart=/usr/lib/openkit/nanohost\n")
        self.write(GUARD, GUARD_BYTES)
        self.path(PERMIT).parent.mkdir(parents=True, exist_ok=True)
        self.write("/sys/fs/cgroup/cgroup.controllers", b"cpu memory pids\n")
        self.group("")
        self.group("/openkit-nanohost.service")
        self.group("/docker-retained.scope")
        self.write("/etc/systemd/system/unrelated.service.d/operator.conf", b"unrelated override\n")
        self.write(GUARD_DIRECTORY + "/notes.txt", b"unknown non-drop-in extension\n")
        self.write(DOMAIN + "/cgroup.stat", b"nr_descendants 2\n")
        self.write("/var/lib/openkit/retained", b"retained data outside this check\n", 0o600)

    def __enter__(self):
        """Return this scenario's fixture."""
        return self

    def __exit__(self, *_args):
        """Remove only this fixture's private tree, including after failed assertions."""
        self.temporary.cleanup()

    def path(self, logical):
        """Confine a fixed logical host path to the fixture tree."""
        return self.root / logical.lstrip("/")

    def write(self, logical, data, mode=0o644):
        """Write an independently specified file with controlled metadata."""
        path = self.path(logical)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(mode)
        return path

    def group(self, suffix, populated=0, procs=b""):
        """Create actual cgroup fact files; this does not create a kernel cgroup."""
        self.write(DOMAIN + suffix + "/cgroup.events", ("populated " + str(populated) + "\nfrozen 0\n").encode())
        self.write(DOMAIN + suffix + "/cgroup.procs", procs)

    def snapshot(self):
        """Record bytes, links and stable metadata without following fixture symlinks."""
        result = {}
        for parent, directories, files in os.walk(self.root, followlinks=False):
            for name in directories + files:
                path = Path(parent) / name
                info = path.lstat()
                payload = None
                if stat.S_ISLNK(info.st_mode):
                    payload = os.readlink(path)
                elif stat.S_ISREG(info.st_mode):
                    payload = path.read_bytes()
                result[str(path.relative_to(self.root))] = (
                    info.st_mode, info.st_uid, info.st_gid, info.st_ino, info.st_mtime_ns, payload
                )
        return result

    def run(self, argv):
        """Answer only fixed read queries; no external process is started."""
        argv = list(argv)
        self.calls.append(argv)
        if not argv or argv[0] not in ("/usr/bin/systemctl", "/usr/bin/busctl"):
            raise AssertionError("unexpected command selector")
        if argv[0] == "/usr/bin/systemctl":
            selected = self.validate_show(argv[1:])
            self.show_count += 1
            kind = "show"
        else:
            required = [
                "--system", "--json=short", "get-property", "org.freedesktop.systemd1",
                "/org/freedesktop/systemd1/unit/openkit_2dnanohost_2eservice",
                "org.freedesktop.systemd1.Unit", "Conditions",
            ]
            if sorted(argv[1:]) != sorted(required):
                raise AssertionError("unexpected D-Bus selector")
            self.condition_count += 1
            kind = "conditions"
        if self.on_command is not None:
            self.on_command(kind)
        if self.result_override is not None:
            result = self.result_override(kind)
            if result is not None:
                return result
        if kind == "show":
            output = "".join(key + "=" + self.facts[key] + "\n" for key in selected if key in self.facts).encode()
        else:
            output = json.dumps(self.conditions, separators=(",", ":")).encode() + b"\n"
        return subprocess.CompletedProcess(argv, 0, output, b"")

    def validate_show(self, args):
        """Validate query semantics while accepting equivalent property-option ordering."""
        positional = []
        selected = []
        iterator = iter(args)
        for token in iterator:
            if token in ("-p", "--property"):
                selected.extend(next(iterator).split(","))
            elif token.startswith("--property="):
                selected.extend(token.split("=", 1)[1].split(","))
            elif token not in ("--no-pager", "--all", "--plain"):
                positional.append(token)
        if sorted(positional) != [UNIT, "show"] or any(key not in self.facts_keys() for key in selected):
            raise AssertionError("unexpected service query")
        return selected if selected else list(self.facts_keys())

    @staticmethod
    def facts_keys():
        """Return the finite accepted service facts, independent of malformed scenario data."""
        return ("MainPID", "ActiveState", "SubState", "ControlGroup", "Slice", "Restart",
                "DropInPaths", "FragmentPath", "NeedDaemonReload", "LoadState")

    def maintenance(self, replacement_id=REPLACEMENT_ID):
        """Construct the actual read-only predicate with only its external tool boundary doubled."""
        return MODULE.SystemdMaintenance(replacement_id, root=self.root, run_command=self.run)


class MaintenanceTests(unittest.TestCase):
    """Prior finite oracles cover current fencing facts and the selected guard posture."""

    def assert_refusal(self, fixture):
        """Require refusal without any filesystem mutation or raw private diagnostics."""
        before = fixture.snapshot()
        with self.assertRaises(Exception) as caught:
            fixture.maintenance().assert_fenced_and_inhibited()
        self.assertEqual(fixture.snapshot(), before)
        text = str(caught.exception)
        self.assertTrue(text)
        self.assertLessEqual(len(text), 256)
        self.assertNotIn(str(fixture.root), text)
        self.assertNotIn("invented-private-marker", text)
        return text

    def test_constructor_is_read_only_and_issues_no_commands(self):
        """Creating an observer grants no lifecycle or guard-creation effect."""
        with Fixture() as fixture:
            fixture.path(GUARD).unlink()
            before = fixture.snapshot()
            fixture.maintenance()
            self.assertEqual(fixture.calls, [])
            self.assertEqual(fixture.snapshot(), before)

    def test_complete_empty_domain_and_exact_guard_pass_without_mutation(self):
        """Historical condition evaluation is separate from the current permit absence."""
        for historical_state in (-1, 0, 1):
            with self.subTest(historical_state=historical_state), Fixture() as fixture:
                fixture.conditions["data"][0][4] = historical_state
                before = fixture.snapshot()
                self.assertIsNone(fixture.maintenance().assert_fenced_and_inhibited())
                self.assertGreaterEqual(fixture.show_count, 2)
                self.assertGreaterEqual(fixture.condition_count, 1)
                self.assertEqual(fixture.snapshot(), before)

    def test_absent_domain_is_distinct_from_missing_existing_facts(self):
        """A proved absent fixed domain can pass with an empty reported ControlGroup."""
        with Fixture() as fixture:
            shutil.rmtree(fixture.path(DOMAIN))
            fixture.facts["ControlGroup"] = ""
            before = fixture.snapshot()
            self.assertIsNone(fixture.maintenance().assert_fenced_and_inhibited())
            self.assertEqual(fixture.snapshot(), before)

    def test_loaded_guard_survives_known_unit_vacancy_and_pending_reload(self):
        """A vacant installer unit does not invalidate its unchanged loaded and persistent guard."""
        with Fixture() as fixture:
            fixture.path(UNIT_PATH).unlink()
            fixture.facts["NeedDaemonReload"] = "yes"
            before = fixture.snapshot()
            self.assertIsNone(fixture.maintenance().assert_fenced_and_inhibited())
            self.assertEqual(fixture.snapshot(), before)

    def test_main_absence_cannot_hide_sibling_processes_or_population(self):
        """Every fixed-domain descendant matters, including nested sibling Sandbox scopes."""
        for suffix, populated, procs in (
            ("/docker-retained.scope", 1, b""),
            ("/docker-retained.scope", 0, b"4123\n"),
            ("/nested/docker-hidden.scope", 1, b"4123\n"),
            ("/openkit-nanohost.service", 0, b"4123\n"),
            ("", 1, b""),
        ):
            with self.subTest(suffix=suffix, populated=populated, procs=procs), Fixture() as fixture:
                fixture.group(suffix, populated, procs)
                self.assert_refusal(fixture)

    def test_missing_or_malformed_kernel_facts_are_not_zero(self):
        """Existing cgroups require complete strict population and process observations."""
        for name, contents in (
            ("cgroup.events", None), ("cgroup.procs", None),
            ("cgroup.events", b""), ("cgroup.events", b"frozen 0\n"),
            ("cgroup.events", b"populated 2\n"),
            ("cgroup.events", b"populated 0\npopulated 1\n"),
            ("cgroup.events", b"populated 0 trailing\n"),
            ("cgroup.events", b"populated 0\n\xff"),
            ("cgroup.procs", b"not-a-pid\n"),
        ):
            with self.subTest(name=name, contents=contents), Fixture() as fixture:
                path = fixture.path(DOMAIN + "/docker-retained.scope/" + name)
                if contents is None:
                    path.unlink()
                else:
                    path.write_bytes(contents)
                self.assert_refusal(fixture)

    def test_directory_count_bound_includes_the_observed_domain_root(self):
        """The selected budget admits 256 observed cgroup directories and refuses 257."""
        for count in (256, 257):
            with self.subTest(count=count), Fixture() as fixture:
                # The domain and its two initial children already consume three observations.
                for index in range(count - 3):
                    fixture.group("/bounded-" + str(index) + ".scope")
                if count > 256:
                    self.assert_refusal(fixture)
                else:
                    before = fixture.snapshot()
                    self.assertIsNone(fixture.maintenance().assert_fenced_and_inhibited())
                    self.assertEqual(fixture.snapshot(), before)

    def test_descendant_depth_bound_is_sixteen_below_the_domain(self):
        """An empty domain is still ineligible when its observation tree exceeds depth 16."""
        for depth in (16, 17):
            with self.subTest(depth=depth), Fixture() as fixture:
                suffix = ""
                for index in range(depth):
                    suffix += "/level-" + str(index)
                    fixture.group(suffix)
                if depth > 16:
                    self.assert_refusal(fixture)
                else:
                    before = fixture.snapshot()
                    self.assertIsNone(fixture.maintenance().assert_fenced_and_inhibited())
                    self.assertEqual(fixture.snapshot(), before)

    def test_kernel_fact_overflow_beyond_4096_bytes_cannot_be_truncated_to_safe(self):
        """An apparent empty prefix cannot hide later conflicting or process-bearing bytes."""
        for name, prefix, suffix in (
            ("cgroup.events", b"populated 0\nfrozen 0\n", b"populated 1\n"),
            ("cgroup.procs", b"", b"4132\n"),
        ):
            with self.subTest(name=name), Fixture() as fixture:
                data = prefix + b"\n" * (4096 - len(prefix)) + suffix
                fixture.write(DOMAIN + "/docker-retained.scope/" + name, data)
                self.assertGreater(len(data), 4096)
                self.assert_refusal(fixture)

    def test_cgroup_v2_anchor_and_fixed_ancestry_are_required(self):
        """Missing v2 evidence and substituted cgroup paths cannot establish domain absence."""
        for logical in ("/sys/fs/cgroup/cgroup.controllers", "/sys/fs/cgroup", "/sys/fs/cgroup/openkit.slice", DOMAIN):
            with self.subTest(logical=logical), Fixture() as fixture:
                path = fixture.path(logical)
                if path.is_dir():
                    moved = path.with_name(path.name + "-moved")
                    path.rename(moved)
                    path.symlink_to(moved, target_is_directory=True)
                else:
                    path.unlink()
                self.assert_refusal(fixture)

    def test_cgroup_fact_symlinks_and_nonregular_paths_refuse(self):
        """Kernel observations never follow symlink facts or adopt a nonregular fact path."""
        for name in ("cgroup.events", "cgroup.procs"):
            for kind in ("symlink", "directory"):
                with self.subTest(name=name, kind=kind), Fixture() as fixture:
                    path = fixture.path(DOMAIN + "/docker-retained.scope/" + name)
                    path.unlink()
                    if kind == "directory":
                        path.mkdir()
                    else:
                        outside = fixture.write("/outside/" + name, b"populated 0\n" if name == "cgroup.events" else b"")
                        path.symlink_to(outside)
                    self.assert_refusal(fixture)

    def test_guard_bytes_modes_and_directory_permissions_are_exact(self):
        """Persistent protection cannot be inferred from the loaded condition alone."""
        for kind in ("missing", "changed-bytes", "wrong-mode", "writable-mode", "directory", "writable-parent", "file-parent"):
            with self.subTest(kind=kind), Fixture() as fixture:
                guard = fixture.path(GUARD)
                if kind == "missing":
                    guard.unlink()
                elif kind == "changed-bytes":
                    guard.write_bytes(GUARD_BYTES.replace(b"Restart=no", b"Restart=always"))
                elif kind == "wrong-mode":
                    guard.chmod(0o600)
                elif kind == "writable-mode":
                    guard.chmod(0o666)
                elif kind == "directory":
                    guard.unlink()
                    guard.mkdir()
                elif kind == "writable-parent":
                    guard.parent.chmod(0o777)
                else:
                    shutil.rmtree(guard.parent)
                    guard.parent.write_bytes(b"not a directory")
                self.assert_refusal(fixture)

    def test_guard_and_parent_symlinks_refuse_even_when_bytes_match(self):
        """Equivalent target bytes do not grant ownership of a substituted config path."""
        for logical in (GUARD, GUARD_DIRECTORY, "/etc/systemd/system"):
            with self.subTest(logical=logical), Fixture() as fixture:
                path = fixture.path(logical)
                moved = path.with_name(path.name + "-moved")
                path.rename(moved)
                path.symlink_to(moved, target_is_directory=moved.is_dir())
                self.assert_refusal(fixture)

    def test_guard_owner_mismatch_observation_refuses(self):
        """Inject a different observer principal against actual fixture file ownership."""
        with Fixture() as fixture:
            with mock.patch.object(os, "geteuid", return_value=os.geteuid() + 1):
                self.assert_refusal(fixture)

    def test_any_permit_path_refuses_including_dangling_symlink(self):
        """A historical false condition cannot conceal a currently present permit."""
        for kind in ("file", "directory", "symlink", "dangling"):
            with self.subTest(kind=kind), Fixture() as fixture:
                path = fixture.path(PERMIT)
                if kind == "file":
                    path.write_bytes(b"")
                elif kind == "directory":
                    path.mkdir()
                else:
                    target = fixture.root / "permit-target"
                    if kind == "symlink":
                        target.write_bytes(b"")
                    path.symlink_to(target)
                self.assert_refusal(fixture)

    def test_extra_own_and_global_dropins_refuse_even_if_not_loaded(self):
        """Disk-only conflicting activation config is preserved rather than silently supported."""
        for base in ("/etc/systemd/system", "/run/systemd/system", "/usr/lib/systemd/system"):
            for directory in (UNIT + ".d", "service.d"):
                with self.subTest(base=base, directory=directory), Fixture() as fixture:
                    fixture.write(base + "/" + directory + "/operator.conf", b"[Service]\nRestart=always\n")
                    self.assert_refusal(fixture)

    def test_service_facts_fail_closed_on_missing_unknown_or_unsafe_values(self):
        """Stopped, loaded, canonical and inhibited are positive facts, not defaults."""
        variants = {
            "MainPID": ("1", "-1", "unknown"), "ActiveState": ("active", "failed", "deactivating"),
            "SubState": ("running", "stop-sigterm"), "ControlGroup": ("/other.slice", "relative"),
            "Slice": ("system.slice", ""), "Restart": ("always", "on-failure", ""),
            "DropInPaths": ("", GUARD + " /etc/systemd/system/service.d/extra.conf"),
            "FragmentPath": ("/run/systemd/system/" + UNIT, ""),
            "NeedDaemonReload": ("unknown", ""), "LoadState": ("not-found", "masked", "error"),
        }
        for key, values in variants.items():
            for value in (None, *values):
                with self.subTest(key=key, value=value), Fixture() as fixture:
                    if value is None:
                        del fixture.facts[key]
                    else:
                        fixture.facts[key] = value
                    self.assert_refusal(fixture)

    def test_typed_conditions_refuse_unknown_core_or_different_semantics(self):
        """Trigger, negate and exact permit identity are required; historical state is bounded."""
        variants = [None, [], {}, {"type": "as", "data": []}, {"type": "a(sbbsi)", "data": []}]
        for index, value in ((0, "ConditionPathIsDirectory"), (1, True), (2, True),
                             (3, "/other/permit"), (4, 2), (1, 0), (4, True)):
            condition = copy.deepcopy(CONDITION)
            condition["data"][0][index] = value
            variants.append(condition)
        condition = copy.deepcopy(CONDITION)
        condition["data"].append(copy.deepcopy(condition["data"][0]))
        variants.append(condition)
        condition = copy.deepcopy(CONDITION)
        condition["data"][0].append("unknown")
        variants.append(condition)
        condition = copy.deepcopy(CONDITION)
        condition["unexpectedRequiredCore"] = True
        variants.append(condition)
        for condition in variants:
            with self.subTest(condition=condition), Fixture() as fixture:
                fixture.conditions = condition
                self.assert_refusal(fixture)

    def test_failed_or_malformed_command_results_refuse_without_raw_output(self):
        """Transport failure, ambiguity and malformed named facts cannot become safe observations."""
        for kind in ("show", "conditions"):
            outputs = [
                subprocess.CompletedProcess([], 1, b"", b"invented-private-marker"),
                subprocess.CompletedProcess([], 0, b"\xff", b""),
                subprocess.CompletedProcess([], 0, b"", b"invented-private-marker"),
            ]
            if kind == "show":
                outputs.extend((subprocess.CompletedProcess([], 0, b"MainPID=0\nMainPID=99\n", b""),
                                subprocess.CompletedProcess([], 0, b"UnknownCore=enabled\n", b"")))
            else:
                outputs.extend((subprocess.CompletedProcess([], 0, b'{} {}\n', b""),
                                subprocess.CompletedProcess([], 0, b'{"type":"a(sbbsi)","type":"as","data":[]}\n', b"")))
            for result in outputs:
                with self.subTest(kind=kind, result=result), Fixture() as fixture:
                    fixture.result_override = lambda query, expected=kind, outcome=result: outcome if query == expected else None
                    self.assert_refusal(fixture)

    def test_final_service_recheck_detects_a_new_main_process(self):
        """A first stopped observation cannot authorize the end of a changed measurement."""
        with Fixture() as fixture:
            def change(kind):
                if kind == "show" and fixture.show_count >= 2:
                    fixture.facts["MainPID"] = "4132"
                    fixture.facts["ActiveState"] = "active"
                    fixture.facts["SubState"] = "running"
            fixture.on_command = change
            self.assert_refusal(fixture)
            self.assertGreaterEqual(fixture.show_count, 2)

    def test_new_sibling_at_final_unit_observation_cannot_be_missed(self):
        """Kernel topology changes across the command bracket require a new truthful refusal."""
        with Fixture() as fixture:
            after = []
            def change(kind):
                if kind == "show" and fixture.show_count == 2:
                    fixture.group("/appearing.scope", 1, b"4132\n")
                    after.append(fixture.snapshot())
            fixture.on_command = change
            with self.assertRaises(Exception):
                fixture.maintenance().assert_fenced_and_inhibited()
            self.assertTrue(after, "fault must occur during a second service observation")
            self.assertEqual(fixture.snapshot(), after[0])

    def test_permit_and_guard_changes_during_command_observation_refuse(self):
        """A file checked before the D-Bus read cannot be reused after substitution."""
        for change_kind in ("permit", "guard", "domain"):
            with self.subTest(change_kind=change_kind), Fixture() as fixture:
                after = []
                def change(kind):
                    if kind != "conditions" or after:
                        return
                    if change_kind == "permit":
                        fixture.path(PERMIT).symlink_to(fixture.root / "missing-permit-target")
                    elif change_kind == "guard":
                        fixture.path(GUARD).write_bytes(GUARD_BYTES.replace(b"Restart=no", b"Restart=always"))
                    else:
                        path = fixture.path(DOMAIN)
                        moved = path.with_name(path.name + "-moved")
                        path.rename(moved)
                        path.symlink_to(moved, target_is_directory=True)
                    after.append(fixture.snapshot())
                fixture.on_command = change
                with self.assertRaises(Exception):
                    fixture.maintenance().assert_fenced_and_inhibited()
                self.assertTrue(after, "fault must occur during the actual condition observation")
                self.assertEqual(fixture.snapshot(), after[0])

    def test_command_exceptions_use_one_fixed_nonsecret_diagnostic(self):
        """Raw OS and tool errors must not reveal private paths or output."""
        messages = []
        for error in (PermissionError(13, "invented-private-marker", "/private/fixture-a"),
                      OSError(5, "invented-private-marker", "/different/fixture-b")):
            with Fixture() as fixture:
                def fail(_kind):
                    raise error
                fixture.on_command = fail
                text = self.assert_refusal(fixture)
                self.assertNotIn(error.filename, text)
                messages.append(text)
        self.assertEqual(messages[0], messages[1])

    def test_unreadable_existing_kernel_fact_is_not_domain_absence(self):
        """Inject a read denial at the OS boundary, including when the suite runs as root."""
        with Fixture() as fixture:
            before = fixture.snapshot()
            denied = []

            def reader(original):
                def open_file(file, *args, **kwargs):
                    if not isinstance(file, int):
                        name = os.fsdecode(file)
                        if name == "cgroup.events" or name.endswith("/cgroup.events"):
                            denied.append(name)
                            raise PermissionError(13, "invented-private-marker", name)
                    return original(file, *args, **kwargs)
                return open_file

            with ExitStack() as patches:
                for owner, name in ((os, "open"), (io, "open"), (builtins, "open")):
                    patches.enter_context(mock.patch.object(owner, name, side_effect=reader(getattr(owner, name))))
                with self.assertRaises(Exception) as caught:
                    fixture.maintenance().assert_fenced_and_inhibited()
            self.assertTrue(denied, "fault must cross a real kernel-fact read boundary")
            self.assertNotIn("invented-private-marker", str(caught.exception))
            self.assertNotIn(str(fixture.root), str(caught.exception))
            self.assertEqual(fixture.snapshot(), before)

    def test_noncanonical_replacement_identifiers_cannot_select_paths(self):
        """The caller supplies one canonical UUID, never a config or command selector."""
        for identifier in (None, "../outside", REPLACEMENT_ID.upper(), "41830d22", ""):
            with self.subTest(identifier=identifier), Fixture() as fixture:
                before = fixture.snapshot()
                with self.assertRaises(Exception):
                    fixture.maintenance(identifier).assert_fenced_and_inhibited()
                self.assertEqual(fixture.snapshot(), before)
                self.assertEqual(fixture.calls, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
