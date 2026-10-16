"""L2 custody tests use actual files; manager facts do not qualify real systemd inhibition."""

import copy
import hashlib
import importlib.util
import itertools
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock


HELPER = Path(__file__).with_name("nanohost-replacement.py")
SPEC = importlib.util.spec_from_file_location("nanohost_replacement", HELPER)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
# Missing implementation must fail collection, rather than become a skip or a product verdict.
SPEC.loader.exec_module(MODULE)

REPLACEMENT_ID = "41830d22-d653-4838-ae3b-0ad78819b2fe"
LIVE = {
    "nanohost": ("usr/lib/openkit/nanohost", 0o755),
    "gateway": ("usr/lib/openkit/openshell-gateway", 0o755),
    "unit": ("etc/systemd/system/openkit-nanohost.service", 0o644),
}
OLD_BYTES = {key: ("old verified " + key + "\n").encode() for key in LIVE}
TARGET_BYTES = {key: ("new verified " + key + "\n").encode() for key in LIVE}


def digest(data):
    """Derive fixture identities independently of the implementation."""
    return hashlib.sha256(data).hexdigest()


class Manager:
    """Expose injected prerequisite facts, without simulating a supervisor."""

    def __init__(self):
        self.valid = True
        self.calls = 0
        self.on_check = None

    def assert_fenced_and_inhibited(self):
        """Fail when the external prerequisite observation is no longer valid."""
        self.calls += 1
        if self.on_check is not None:
            self.on_check()
        if not self.valid:
            raise RuntimeError("fixture prerequisite unavailable")


class CustodyTests(unittest.TestCase):
    """Assert fixed-path retention and refusal from independently authored filesystem fixtures."""

    def setUp(self):
        """Create only disposable fixed-path lookalikes and retained-data sentinels."""
        self.temporary = tempfile.TemporaryDirectory(prefix="custody-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.manager = Manager()
        self.request = {
            "replacementId": REPLACEMENT_ID,
            "old": {key: digest(data) for key, data in OLD_BYTES.items()},
            "target": {key: digest(data) for key, data in TARGET_BYTES.items()},
        }
        for key, (_, mode) in LIVE.items():
            target = self.live(key)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(OLD_BYTES[key])
            target.chmod(mode)
        self.sentinels = {
            "etc/openkit/config.json": b'{"configuredIdentity":"retained"}\n',
            "etc/openkit/token-a": b"invented-fixture-token\n",
            "etc/openkit/token-a.json": b'{"slot":"A"}\n',
            "etc/openkit/token-b": b"",
            "etc/openkit/token-b.json": b'{"slot":"B"}\n',
            "var/lib/openkit/nanohost-images/image": b"retained image",
            "var/lib/openkit/nanohost-work/history": b"retained native history",
            "var/lib/openkit/nanohost/epoch": b"epoch is outside payload scope",
            "run/openkit/nanohost/epoch": b"runtime is outside payload scope",
            "var/lib/openkit/private-scan/content": b"retained scan",
            "var/lib/openkit/evidence/check": b"retained evidence",
            "usr/lib/openkit/unknown-file": b"unknown extension",
            "etc/systemd/system/openkit-nanohost.service.d/operator.conf": b"unrelated override",
            "etc/systemd/system/openkit-nanohost.service.d/maintenance.conf": b"fixture inhibition",
        }
        for name, data in self.sentinels.items():
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o600)
        self.original = {key: self.identity(self.live(key)) for key in LIVE}
        self.original_sentinels = {
            name: self.identity(self.root / name) for name in self.sentinels
        }

    def live(self, key):
        """Resolve a test-owned fixed installer destination."""
        return self.root / LIVE[key][0]

    def recovery(self, key):
        """Resolve the agreed exclusive, sibling recovery location."""
        live = self.live(key)
        return live.parent / (".openkit-nanohost-replacement-" + REPLACEMENT_ID) / live.name

    def reserved(self, key):
        """Resolve the unchanged installer's adjacent temporary destination."""
        live = self.live(key)
        return live.with_name("." + live.name + ".openkit-install")

    @staticmethod
    def identity(path):
        """Read bytes and stable metadata; atime and link count may change during verification."""
        info = path.lstat()
        return (path.read_bytes(), info.st_mode, info.st_uid, info.st_gid, info.st_ino, info.st_mtime_ns)

    def invoke(self, request=None):
        """Invoke the real candidate; no alternate filesystem implementation is provided."""
        return MODULE.vacate_verified_payloads(
            self.request if request is None else request, self.manager, root=self.root
        )

    def assert_sentinels(self):
        """Check unrelated retained bytes, identities and inhibition were not changed."""
        for name, expected in self.original_sentinels.items():
            self.assertEqual(self.identity(self.root / name), expected, name)

    def assert_live_preserved(self):
        """Check that no destination was vacated after a refusal before mutation."""
        for key in LIVE:
            self.assertEqual(self.identity(self.live(key)), self.original[key], key)
        self.assert_sentinels()

    def assert_retained(self, key):
        """Check custody is private and preserves old payload bytes and required metadata."""
        recovered = self.recovery(key)
        info = recovered.lstat()
        directory = recovered.parent.lstat()
        self.assertTrue(stat.S_ISREG(info.st_mode))
        self.assertFalse(recovered.is_symlink())
        self.assertEqual(recovered.read_bytes(), OLD_BYTES[key])
        self.assertEqual(stat.S_IMODE(info.st_mode), LIVE[key][1])
        self.assertEqual((info.st_uid, info.st_gid), self.original[key][2:4])
        self.assertTrue(stat.S_ISDIR(directory.st_mode))
        self.assertEqual(stat.S_IMODE(directory.st_mode), 0o700)
        self.assertEqual((directory.st_uid, directory.st_gid), (os.geteuid(), os.getegid()))

    def path_for_call(self, name, dir_fd=None, **_kwargs):
        """Resolve syscall observations, including operations through a pinned directory fd."""
        path = Path(os.fsdecode(name))
        if path.is_absolute():
            return path
        if dir_fd is not None:
            return Path(os.readlink("/proc/self/fd/" + str(dir_fd))) / path
        return Path.cwd() / path

    def test_each_changed_subset_retains_only_differing_payloads(self):
        """Every subset leaves exact targets untouched and vacates only verified differing files."""
        for count in range(4):
            for changed in itertools.combinations(LIVE, count):
                with self.subTest(changed=changed):
                    # Each subset needs new exclusive custody paths; use a fresh fixture instance.
                    case = CustodyTests()
                    case.setUp()
                    try:
                        for key in LIVE:
                            if key not in changed:
                                case.request["target"][key] = case.request["old"][key]
                        result = case.invoke()
                        self.assertEqual(set(result), {"retained", "unchanged"})
                        self.assertCountEqual(result["retained"], changed)
                        self.assertCountEqual(result["unchanged"], set(LIVE) - set(changed))
                        for key in LIVE:
                            if key in changed:
                                self.assertFalse(case.live(key).exists())
                                case.assert_retained(key)
                            else:
                                self.assertEqual(case.identity(case.live(key)), case.original[key])
                                self.assertFalse(case.recovery(key).exists())
                        case.assert_sentinels()
                    finally:
                        case.doCleanups()

    def test_entire_old_set_is_verified_before_any_vacancy(self):
        """A late payload mismatch cannot permit an earlier valid payload to be vacated."""
        self.live("unit").write_bytes(b"unexplained local edit")
        self.original["unit"] = self.identity(self.live("unit"))
        with self.assertRaises(Exception):
            self.invoke()
        self.assert_live_preserved()

    def test_wrong_modes_refuse_without_vacancy(self):
        """Wrong executable or unit metadata is not silently repaired or adopted."""
        for key in LIVE:
            with self.subTest(key=key):
                self.live(key).chmod(0o600)
                self.original[key] = self.identity(self.live(key))
                with self.assertRaises(Exception):
                    self.invoke()
                self.assert_live_preserved()
                self.live(key).chmod(LIVE[key][1])
                self.original[key] = self.identity(self.live(key))

    def test_wrong_owner_observation_refuses_without_vacancy(self):
        """An injected caller identity makes real fixture ownership ineligible for custody."""
        with mock.patch.object(os, "geteuid", return_value=os.geteuid() + 1):
            with self.assertRaises(Exception):
                self.invoke()
        self.assert_live_preserved()

    def test_exact_reserved_target_files_remain_untouched(self):
        """Verified target temporaries belong to the unchanged installer, not this helper."""
        expected = {}
        for key, (_, mode) in LIVE.items():
            self.reserved(key).write_bytes(TARGET_BYTES[key])
            self.reserved(key).chmod(mode)
            expected[key] = self.identity(self.reserved(key))
        result = self.invoke()
        self.assertCountEqual(result["retained"], LIVE)
        for key in LIVE:
            self.assertEqual(self.identity(self.reserved(key)), expected[key])
            self.assert_retained(key)
        self.assert_sentinels()

    def test_conflicting_reserved_temporaries_refuse_before_any_vacancy(self):
        """Reserved paths cannot hide edits, wrong metadata, symlinks or nonregular files."""
        outside = self.root / "outside-reserved"
        outside.write_bytes(b"unrelated temporary")
        expected_outside = self.identity(outside)
        for key, (_, mode) in LIVE.items():
            for kind in ("bytes", "mode", "symlink", "directory"):
                with self.subTest(key=key, kind=kind):
                    reserved = self.reserved(key)
                    if kind == "directory":
                        reserved.mkdir()
                    elif kind == "symlink":
                        reserved.symlink_to(outside)
                    else:
                        reserved.write_bytes(b"unexpected edit" if kind == "bytes" else TARGET_BYTES[key])
                        reserved.chmod(0o600 if kind == "mode" else mode)
                    with self.assertRaises(Exception):
                        self.invoke()
                    self.assert_live_preserved()
                    self.assertEqual(self.identity(outside), expected_outside)
                    if kind == "directory":
                        self.assertTrue(reserved.is_dir())
                        reserved.rmdir()
                    elif kind == "symlink":
                        self.assertTrue(reserved.is_symlink())
                        reserved.unlink()
                    else:
                        expected = b"unexpected edit" if kind == "bytes" else TARGET_BYTES[key]
                        self.assertEqual(reserved.read_bytes(), expected)
                        self.assertEqual(stat.S_IMODE(reserved.stat().st_mode), 0o600 if kind == "mode" else mode)
                        reserved.unlink()

    def test_reserved_conflict_appearing_at_vacancy_gate_is_preserved(self):
        """A fresh prerequisite observation cannot conceal a newly conflicting temporary."""
        appeared = []

        def appear():
            if any(self.recovery(key).exists() for key in LIVE) and not appeared:
                self.reserved("unit").write_bytes(b"appearing reserved conflict")
                self.reserved("unit").chmod(0o644)
                appeared.append(True)

        self.manager.on_check = appear
        with self.assertRaises(Exception):
            self.invoke()
        self.assertTrue(appeared, "fault must occur at a recheck after actual custody")
        self.assertEqual(self.reserved("unit").read_bytes(), b"appearing reserved conflict")
        self.assert_live_preserved()

    def test_missing_nonregular_and_symlink_live_payloads_refuse(self):
        """The payload contract does not adopt missing paths, directories or symlink targets."""
        target = self.live("unit")
        outside = self.root / "unrelated-unit"
        outside.write_bytes(OLD_BYTES["unit"])
        outside.chmod(0o644)
        before = self.identity(outside)
        for kind in ("missing", "directory", "symlink"):
            with self.subTest(kind=kind):
                target.unlink()
                if kind == "directory":
                    target.mkdir()
                elif kind == "symlink":
                    target.symlink_to(outside)
                with self.assertRaises(Exception):
                    self.invoke()
                for key in ("nanohost", "gateway"):
                    self.assertEqual(self.identity(self.live(key)), self.original[key])
                self.assertEqual(self.identity(outside), before)
                self.assert_sentinels()
                if kind == "directory":
                    target.rmdir()
                elif kind == "symlink":
                    target.unlink()
                target.write_bytes(OLD_BYTES["unit"])
                target.chmod(0o644)

    def test_unknown_or_invalid_request_core_refuses_without_mutation(self):
        """The request cannot select extra operations, paths or unverified identities."""
        variants = []
        for value in ("../outside", REPLACEMENT_ID.upper(), "41830d22", None):
            request = copy.deepcopy(self.request)
            request["replacementId"] = value
            variants.append(request)
        for key in ("old", "target"):
            for value in (None, {}, {"nanohost": "f" * 64}):
                request = copy.deepcopy(self.request)
                request[key] = value
                variants.append(request)
            for value in ("A" * 64, "g" * 64, "f" * 63, None, 42):
                request = copy.deepcopy(self.request)
                request[key]["unit"] = value
                variants.append(request)
            request = copy.deepcopy(self.request)
            request[key]["command"] = "forbidden"
            variants.append(request)
        for key in ("root", "command", "resume"):
            request = copy.deepcopy(self.request)
            request[key] = "forbidden"
            variants.append(request)
        variants.extend((None, [], {}))
        for request in variants:
            with self.subTest(request=request):
                # Pass None directly: invoke(None) selects the ordinary request by design.
                with self.assertRaises(Exception):
                    MODULE.vacate_verified_payloads(request, self.manager, root=self.root)
                self.assert_live_preserved()
                self.assertFalse(any(self.root.rglob(".openkit-nanohost-replacement-*")))

    def test_occupied_recovery_directory_refuses_without_resume(self):
        """An exact previous copy is still occupied custody, never permission to resume."""
        recovered = self.recovery("unit")
        recovered.parent.mkdir(mode=0o700)
        recovered.write_bytes(OLD_BYTES["unit"])
        recovered.chmod(0o644)
        before = self.identity(recovered)
        with self.assertRaises(Exception):
            self.invoke()
        self.assert_live_preserved()
        self.assertEqual(self.identity(recovered), before)

    def test_symlink_recovery_directory_refuses_without_following_it(self):
        """An attacker-selected recovery location cannot receive or replace old payloads."""
        outside = self.root / "outside-recovery"
        outside.mkdir()
        sentinel = outside / "keep"
        sentinel.write_bytes(b"unrelated custody")
        self.recovery("nanohost").parent.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(Exception):
            self.invoke()
        self.assert_live_preserved()
        self.assertEqual(list(outside.iterdir()), [sentinel])

    def test_appearing_recovery_file_is_never_overwritten(self):
        """A file appearing after directory creation remains intact and blocks source vacancy."""
        original_mkdir = os.mkdir
        appeared = []

        def mkdir(name, mode=0o777, **kwargs):
            original_mkdir(name, mode, **kwargs)
            directory = self.path_for_call(name, **kwargs)
            if directory.name == ".openkit-nanohost-replacement-" + REPLACEMENT_ID:
                for key in LIVE:
                    if self.recovery(key).parent == directory:
                        unexpected = directory / self.live(key).name
                        unexpected.write_bytes(b"unexpected appearing payload")
                        appeared.append(unexpected)

        with mock.patch.object(os, "mkdir", side_effect=mkdir):
            with self.assertRaises(Exception):
                self.invoke()
        self.assertTrue(appeared, "fault must create a real conflicting custody file")
        for path in appeared:
            self.assertEqual(path.read_bytes(), b"unexpected appearing payload")
        self.assert_live_preserved()

    def test_prerequisite_refusal_leaves_payloads_and_inhibition_untouched(self):
        """Unknown fencing or inhibition blocks every vacancy."""
        self.manager.valid = False
        with self.assertRaises(Exception):
            self.invoke()
        self.assert_live_preserved()

    def test_changed_prerequisite_after_retention_blocks_vacancy(self):
        """A prerequisite observed at entry cannot authorize vacancy after it changes."""
        original_fsync = os.fsync
        changed = []

        def fsync(fd):
            original_fsync(fd)
            if any(self.recovery(key).exists() for key in LIVE):
                changed.append(True)
                self.manager.valid = False

        with mock.patch.object(os, "fsync", side_effect=fsync):
            with self.assertRaises(Exception):
                self.invoke()
        self.assertTrue(changed, "fault must occur after real old-byte retention")
        self.assert_live_preserved()

    def test_fsync_failure_cannot_vacate_a_source(self):
        """A failed durability boundary cannot be reported as protected custody."""
        with mock.patch.object(os, "fsync", side_effect=OSError("private fixture path")):
            with self.assertRaises(Exception):
                self.invoke()
        self.assert_live_preserved()

    def test_first_actual_vacancy_has_durable_custody_and_failure_keeps_it(self):
        """A post-unlink failure preserves old bytes and inhibition with no new install."""
        original_unlink = os.unlink
        original_fsync = os.fsync
        synced = set()
        vacated = []

        def fsync(fd):
            original_fsync(fd)
            info = os.fstat(fd)
            synced.add((info.st_dev, info.st_ino))

        def unlink(name, *args, **kwargs):
            path = self.path_for_call(name, **kwargs)
            key = next((key for key in LIVE if path == self.live(key)), None)
            if key is None:
                return original_unlink(name, *args, **kwargs)
            self.assert_retained(key)
            for retained_path in (self.recovery(key), self.recovery(key).parent, path.parent):
                info = retained_path.stat()
                self.assertIn((info.st_dev, info.st_ino), synced, str(retained_path))
            self.assertTrue(self.manager.valid)
            original_unlink(name, *args, **kwargs)
            vacated.append(key)
            raise OSError("injected after actual vacancy at secret-fixture-path")

        # No lifecycle call belongs to this helper. Fail any attempted subprocess handoff.
        with mock.patch.object(os, "fsync", side_effect=fsync):
            with mock.patch.object(os, "unlink", side_effect=unlink):
                with mock.patch("subprocess.Popen", side_effect=AssertionError("unexpected lifecycle call")) as launch:
                    with self.assertRaises(Exception):
                        self.invoke()
                    launch.assert_not_called()
        self.assertEqual(len(vacated), 1, "fault must follow exactly one actual source removal")
        self.assert_retained(vacated[0])
        self.assertFalse(self.live(vacated[0]).exists())
        for key in set(LIVE) - set(vacated):
            self.assertEqual(self.identity(self.live(key)), self.original[key])
        self.assert_sentinels()
        self.assertTrue(self.manager.valid)

    def test_parent_symlink_substitution_refuses_without_touching_outside(self):
        """A substitution at a manager boundary cannot redirect the fixed-path operation."""
        parent = self.live("nanohost").parent
        moved = parent.with_name("old-openkit")
        outside = self.root / "outside"
        outside.mkdir()
        for key in ("nanohost", "gateway"):
            (outside / self.live(key).name).write_bytes(OLD_BYTES[key])
            (outside / self.live(key).name).chmod(0o755)
        expected = {p.name: self.identity(p) for p in outside.iterdir()}

        def substitute():
            if not moved.exists():
                parent.rename(moved)
                parent.symlink_to(outside, target_is_directory=True)

        self.manager.on_check = substitute
        with self.assertRaises(Exception):
            self.invoke()
        self.assertEqual({p.name: self.identity(p) for p in outside.iterdir()}, expected)
        for key in ("nanohost", "gateway"):
            self.assertEqual(self.identity(moved / self.live(key).name), self.original[key])
        self.assertEqual(self.identity(self.live("unit")), self.original["unit"])

    def test_oserror_diagnostics_are_fixed_and_do_not_echo_paths(self):
        """Distinct raw filesystem failures produce one bounded non-secret diagnostic."""
        messages = []
        for private_path in ("/private/fixture-a", "/different/secret-fixture-b"):
            with mock.patch.object(os, "fsync", side_effect=OSError(13, "denied", private_path)):
                with self.assertRaises(Exception) as caught:
                    self.invoke()
            message = str(caught.exception)
            self.assertNotIn(private_path, message)
            self.assertNotIn(str(self.root), message)
            self.assertGreater(len(message), 0)
            self.assertLessEqual(len(message), 256)
            messages.append(message)
            self.assert_live_preserved()
            # Custody may have been created before the injected failure. A new invocation must
            # not mistake that occupied path for the second, independently injected failure.
            for directory in self.root.rglob(".openkit-nanohost-replacement-*"):
                for child in directory.iterdir():
                    child.unlink()
                directory.rmdir()
        self.assertEqual(messages[0], messages[1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
