"""Bounded external operator maintenance for the fixed installed NanoHost service.

The caller owns the exclusive maintenance window, verified release inputs and
retained-input admission. This module neither installs payloads nor judges Core
readiness. Its injected root and command transport exist for contained tests;
the privileged operator entry must use the fixed real root. Command uncertainty
retains custody for inspection and never authorizes replay or automatic repair.
"""

import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import uuid


def _load(name):
    """Load the adjacent existing owner under isolated Python imports."""
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_systemd = _load("nanohost-systemd")
_replacement = _load("nanohost-replacement")
_UNIT = _systemd._UNIT
_FRAGMENT = _systemd._FRAGMENT
_GROUP = _systemd._GROUP
_DIRECTORY = _systemd._DIRECTORY
_refuse = _systemd._refuse
MaintenanceRefusal = _systemd.MaintenanceRefusal
bounded_default = _systemd.bounded_default


def _hash(value):
    """Accept only one exact lowercase SHA-256 identity."""
    if type(value) is not str or re.fullmatch(r"[a-f0-9]{64}", value) is None:
        _refuse()


def _hashes(value):
    """Keep the target authority closed to the three installer-owned payloads."""
    if type(value) is not dict or set(value) != set(_replacement._PAYLOADS):
        _refuse()
    for digest in value.values():
        _hash(digest)


def _stamp(value):
    """Validate a native process assertion without coercing PID or kernel ticks."""
    if (type(value) is not dict or set(value) != {"bootId", "pid", "startTimeTicks"} or
            type(value["bootId"]) is not str or str(uuid.UUID(value["bootId"])) != value["bootId"] or
            type(value["pid"]) is not int or not 0 < value["pid"] <= 2147483647 or
            type(value["startTimeTicks"]) is not str or
            re.fullmatch(r"[1-9][0-9]{0,19}", value["startTimeTicks"]) is None):
        _refuse()


def _identity(info):
    """Include name-substitution and in-place mutation fields in owned-file checks."""
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


class Maintenance(_systemd.SystemdMaintenance):
    """Establish inhibition, attempt one controlled start, and restore supervision.

    The inherited public fence predicate remains the custody module's observer.
    Guard and attempt files are interruption evidence, never resume authority.
    A fresh instance can finalize only from current measured facts and the exact
    supplied incarnation. It cannot repeat begin or start from existing custody.
    """

    def _selectors(self):
        """Extend the existing supervisor selectors with persistent attempt custody."""
        super()._selectors()
        self.attempt = _FRAGMENT + ".d/.openkit-replacement-" + self.identifier + ".attempted"

    def _admit(self):
        """Validate selectors and the pinned root before any stage observation."""
        self._selectors()
        with _replacement._root(self.root):
            pass

    def assert_fenced_and_inhibited(self):
        """Refresh actual activation admission before the existing full-domain predicate."""
        try:
            self._admit()
            self._unit_roots(True)
            self._activation()
            super().assert_fenced_and_inhibited()
        except Exception:
            _refuse()

    def _bus(self, name, signature):
        """Read one exact typed manager or unit fact without diagnostic passthrough."""
        manager = name == "UnitPath"
        raw = self._query(["/usr/bin/busctl", "--system", "--json=short", "get-property",
                           "org.freedesktop.systemd1",
                           "/org/freedesktop/systemd1" if manager else
                           "/org/freedesktop/systemd1/unit/openkit_2dnanohost_2eservice",
                           "org.freedesktop.systemd1.Manager" if manager else "org.freedesktop.systemd1.Unit", name])
        value = json.loads(raw, object_pairs_hook=_systemd._unique)
        if type(value) is not dict or set(value) != {"type", "data"} or value["type"] != signature:
            _refuse()
        return value["data"]

    def _activation(self):
        """Require no queued service job or manager-reported external trigger."""
        job = self._bus("Job", "(uo)")
        if (type(job) is not list or len(job) != 2 or type(job[0]) is not int or
                job[0] != 0 or job[1] != "/" or self._bus("TriggeredBy", "as") != []):
            _refuse()

    def _unit_roots(self, guarded):
        """Inspect every actual manager root and applicable exact, prefix and type drop-in.

        Only the standard /lib to /usr/lib directory alias is admitted. All other
        links fail closed, including links that would escape an injected root.
        Absent roots are allowed only after checking their existing ancestors.
        """
        paths = self._bus("UnitPath", "as")
        if type(paths) is not list or not 0 < len(paths) <= 64:
            _refuse()
        admitted = set()
        for logical in paths:
            if (type(logical) is not str or not logical.startswith("/") or
                    str(Path(logical)) != logical or ".." in Path(logical).parts or
                    len(logical) > 4096 or logical == "/"):
                _refuse()
            if logical == "/lib" or logical.startswith("/lib/"):
                with self._directory("/") as fd:
                    try:
                        alias = os.stat("lib", dir_fd=fd, follow_symlinks=False)
                    except FileNotFoundError:
                        alias = None
                    if alias is not None and stat.S_ISLNK(alias.st_mode):
                        if os.readlink("lib", dir_fd=fd) not in ("usr/lib", "/usr/lib"):
                            _refuse()
                        logical = "/usr/lib" + logical[4:]
            admitted.add(logical)
            with self._directory(logical, absent=True, config=True):
                pass
            for suffix in (_UNIT + ".d", "openkit-.service.d", "service.d"):
                directory = logical + "/" + suffix
                with self._directory(directory, absent=True, config=True) as fd:
                    if fd is None:
                        continue
                    names = os.listdir(fd)
                    if len(names) > 1024:
                        _refuse()
                    for name in names:
                        if name.endswith(".conf") and not (guarded and directory + "/" + name == self.guard):
                            _refuse()
        if "/etc/systemd/system" not in admitted:
            _refuse()

    def _absent(self, logical):
        """Require actual non-following absence; inaccessible paths remain unknown."""
        with self._directory(str(Path(logical).parent), absent=True, config=True) as fd:
            if fd is not None:
                try:
                    os.stat(Path(logical).name, dir_fd=fd, follow_symlinks=False)
                except FileNotFoundError:
                    return
                _refuse()

    def _payloads(self, hashes):
        """Reuse custody's fixed destinations and stable payload identity checks."""
        identities = {}
        with _replacement._root(self.root) as root:
            for key, (directory, name, _temporary, mode) in _replacement._PAYLOADS.items():
                with _replacement._parent(root, directory) as parent:
                    with _replacement._payload(parent, name, hashes[key], mode) as (fd, identity):
                        named = os.stat(name, dir_fd=parent, follow_symlinks=False)
                        if _identity(os.fstat(fd)) != _identity(named):
                            _refuse()
                        identities[key] = identity
        return identities

    def _old_unit(self, digest):
        """Require canonical old unit bytes and metadata before creating inhibition."""
        with _replacement._root(self.root) as root, _replacement._parent(root, "etc/systemd/system") as parent:
            with _replacement._payload(parent, _UNIT, digest, 0o644) as (fd, _):
                if _identity(os.fstat(fd)) != _identity(os.stat(_UNIT, dir_fd=parent, follow_symlinks=False)):
                    _refuse()

    def _owned(self, logical, data, mode):
        """Read exact operation-owned regular bytes and retain their named identity."""
        with self._directory(str(Path(logical).parent), config=True) as parent:
            info = os.stat(Path(logical).name, dir_fd=parent, follow_symlinks=False)
            if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != mode or
                    (info.st_uid, info.st_gid) != (os.geteuid(), os.getegid()) or
                    self._read(parent, Path(logical).name, 4096) != data or
                    _identity(info) != _identity(os.stat(Path(logical).name, dir_fd=parent, follow_symlinks=False))):
                _refuse()
            return _identity(info)

    def _attempt_bytes(self):
        """Keep attempted-start custody exact and independent of a later caller assertion."""
        return ("openkit-nanohost-start-attempt " + self.identifier + "\n").encode()

    def _create(self, parent, name, data, mode, *, durable):
        """Publish exclusively; persist the file and parent before dependent effects."""
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode, dir_fd=parent)
        try:
            os.fchmod(fd, mode)
            remaining = memoryview(data)
            while remaining:
                written = os.write(fd, remaining)
                if written <= 0:
                    _refuse()
                remaining = remaining[written:]
            if durable:
                os.fsync(fd)
            identity = _identity(os.fstat(fd))
        finally:
            os.close(fd)
        if durable:
            os.fsync(parent)
        if identity != _identity(os.stat(name, dir_fd=parent, follow_symlinks=False)):
            _refuse()
        return identity

    def _effect(self, *arguments):
        """Issue one fixed supervisor effect with bounded empty successful output."""
        if self._query(["/usr/bin/systemctl", "--no-pager", *arguments]):
            _refuse()

    def _running_facts(self, guarded):
        """Require the exact active service and its accepted current supervision."""
        facts = self._service_facts()
        expected = {"ActiveState": "active", "SubState": "running", "ControlGroup": _GROUP,
                    "Slice": "openkit-nanohost.slice", "Restart": "no" if guarded else "always",
                    "DropInPaths": self.guard if guarded else "", "FragmentPath": _FRAGMENT,
                    "NeedDaemonReload": "no", "LoadState": "loaded"}
        if (any(facts[key] != value for key, value in expected.items()) or
                re.fullmatch(r"[1-9][0-9]{0,9}", facts["MainPID"]) is None):
            _refuse()
        return facts

    def _process(self, pid):
        """Read actual boot, start ticks and unified membership through pinned parents."""
        with self._directory("/proc/sys/kernel/random") as fd:
            boot = self._read(fd, "boot_id", 128).decode("ascii").strip()
        with self._directory("/proc/" + str(pid)) as fd:
            raw = self._read(fd, "stat", 4096).decode("ascii").strip()
            membership = self._read(fd, "cgroup", 4096).decode("ascii")
        prefix, separator, fields = raw.rpartition(") ")
        values = fields.split()
        if (not separator or not prefix.startswith(str(pid) + " (") or len(values) < 20 or
                values[0] in ("Z", "X", "x") or membership != "0::" + _GROUP + "\n"):
            _refuse()
        result = {"bootId": boot, "pid": pid, "startTimeTicks": values[19]}
        _stamp(result)
        with self._directory("/sys/fs/cgroup" + _GROUP) as fd:
            processes = self._read(fd, "cgroup.procs", 16384).decode("ascii").splitlines()
            if str(pid) not in processes or any(re.fullmatch(r"[1-9][0-9]*", value) is None for value in processes):
                _refuse()
        return result

    def _incarnation(self, guarded):
        """Bracket actual process measurements with unchanged supervisor observations."""
        facts = self._running_facts(guarded)
        first = self._process(int(facts["MainPID"]))
        if facts != self._running_facts(guarded) or first != self._process(first["pid"]):
            _refuse()
        return first

    def begin(self, old_unit_sha256):
        """Admit an active predecessor, persist inhibition, then stop its whole domain."""
        try:
            _hash(old_unit_sha256)
            self._admit()
            self._unit_roots(False)
            self._activation()
            self._old_unit(old_unit_sha256)
            self._incarnation(False)
            for logical in (self.guard, self.attempt, str(Path(self.permit).parent)):
                self._absent(logical)
            for directory in ("/usr/lib/openkit", "/etc/systemd/system"):
                self._absent(directory + "/.openkit-nanohost-replacement-" + self.identifier)
            if self._bus("Conditions", "a(sbbsi)") != []:
                _refuse()
            self._old_unit(old_unit_sha256)
            self._running_facts(False)
            with self._directory("/etc/systemd/system", config=True) as parent:
                try:
                    os.mkdir(_UNIT + ".d", 0o755, dir_fd=parent)
                    os.fsync(parent)
                except FileExistsError:
                    pass
            with self._directory(_FRAGMENT + ".d", config=True) as parent:
                self._create(parent, Path(self.guard).name, self._guard_bytes(), 0o644, durable=True)
            self._effect("daemon-reload")
            self._effect("stop", _UNIT)
            self._effect("stop", "openkit-nanohost.slice")
            self._unit_roots(True)
            self._activation()
            self.assert_fenced_and_inhibited()
            if self._service()["NeedDaemonReload"] != "no":
                _refuse()
        except Exception:
            _refuse()

    def start_once(self, target_payload_hashes):
        """Verify a complete target and persist the attempt before its one volatile permit."""
        try:
            _hashes(target_payload_hashes)
            self._admit()
            self._absent(self.attempt)
            self._absent(str(Path(self.permit).parent))
            self._unit_roots(True)
            self._activation()
            original = self._payloads(target_payload_hashes)
            self.assert_fenced_and_inhibited()
            self._effect("daemon-reload")
            self._unit_roots(True)
            self._activation()
            self.assert_fenced_and_inhibited()
            if self._service()["NeedDaemonReload"] != "no" or original != self._payloads(target_payload_hashes):
                _refuse()
            with self._directory(_FRAGMENT + ".d", config=True) as parent:
                self._create(parent, Path(self.attempt).name, self._attempt_bytes(), 0o644, durable=True)
            # Attempt custody survives interruption before this volatile permit.
            # There is no promise that the permit survives a host restart.
            self.assert_fenced_and_inhibited()
            self._activation()
            if original != self._payloads(target_payload_hashes):
                _refuse()
            with self._directory("/run", config=True) as parent:
                os.mkdir(Path(self.permit).parent.name, 0o700, dir_fd=parent)
            with self._directory(str(Path(self.permit).parent), config=True) as parent:
                if stat.S_IMODE(os.fstat(parent).st_mode) != 0o700:
                    _refuse()
                permit = self._create(parent, "permit", b"", 0o600, durable=False)
            result = self.run_command(["/usr/bin/systemctl", "--no-pager", "start", _UNIT])
            if (type(result.returncode) is not int or type(result.stdout) is not bytes or
                    type(result.stderr) is not bytes or len(result.stdout) > 16384 or len(result.stderr) > 256):
                _refuse()
            if result.returncode != 0:
                # A known refusal permits removal only of the exact unconsumed
                # object we published. A substituted or unknown name is retained.
                with self._directory(str(Path(self.permit).parent), config=True) as parent:
                    try:
                        named = os.stat("permit", dir_fd=parent, follow_symlinks=False)
                    except FileNotFoundError:
                        pass
                    else:
                        if _identity(named) == permit and self._owned(self.permit, b"", 0o600) == permit:
                            os.unlink("permit", dir_fd=parent)
                _refuse()
            if result.stdout or result.stderr:
                _refuse()
            self._guard()
            self._owned(self.attempt, self._attempt_bytes(), 0o644)
            self._conditions()
            incarnation = self._incarnation(True)
            if original != self._payloads(target_payload_hashes) or incarnation != self._incarnation(True):
                _refuse()
            return incarnation
        except Exception:
            _refuse()

    def finalize(self, expected_incarnation, target_payload_hashes):
        """Remove only the exact own guard and restore supervision for the same process."""
        try:
            _stamp(expected_incarnation)
            _hashes(target_payload_hashes)
            self._admit()
            self._unit_roots(True)
            self._activation()
            self._guard()
            guard = self._owned(self.guard, self._guard_bytes(), 0o644)
            attempt = self._owned(self.attempt, self._attempt_bytes(), 0o644)
            self._conditions()
            payloads = self._payloads(target_payload_hashes)
            if self._incarnation(True) != expected_incarnation:
                _refuse()
            self._guard()
            if payloads != self._payloads(target_payload_hashes):
                _refuse()
            with self._directory(_FRAGMENT + ".d", config=True) as parent:
                if self._owned(self.guard, self._guard_bytes(), 0o644) != guard:
                    _refuse()
                os.unlink(Path(self.guard).name, dir_fd=parent)
                os.fsync(parent)
            self._effect("daemon-reload")
            self._unit_roots(False)
            self._activation()
            self._absent(self.guard)
            self._absent(self.permit)
            if (self._bus("Conditions", "a(sbbsi)") != [] or
                    self._incarnation(False) != expected_incarnation or
                    payloads != self._payloads(target_payload_hashes) or
                    self._owned(self.attempt, self._attempt_bytes(), 0o644) != attempt or
                    self._incarnation(False) != expected_incarnation):
                _refuse()
        except Exception:
            _refuse()
