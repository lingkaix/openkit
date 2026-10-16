"""Read-only stopped-domain and persistent-guard predicate for operator maintenance.

This predicate does not create inhibition or authorize a host posture. The caller
must first admit the actual manager search path and activation sources. A passing
fixture is not proof of real systemd inhibition across reload or manager restart.
"""

from contextlib import contextmanager, ExitStack
import json
import os
from pathlib import Path
import selectors
import stat
import subprocess
import time
import uuid


_UNIT = "openkit-nanohost.service"
_FRAGMENT = "/etc/systemd/system/" + _UNIT
_DOMAIN = "/sys/fs/cgroup/openkit.slice/openkit-nanohost.slice"
_GROUP = "/openkit.slice/openkit-nanohost.slice/" + _UNIT
_PROPERTIES = ("MainPID", "ActiveState", "SubState", "ControlGroup", "Slice", "Restart",
               "DropInPaths", "FragmentPath", "NeedDaemonReload", "LoadState")
_DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK


class MaintenanceRefusal(Exception):
    """A closed diagnostic that contains no host output or private paths."""


def _refuse():
    """Keep every failed observation unknown without exposing tool diagnostics."""
    raise MaintenanceRefusal("NanoHost maintenance: current fencing and persistent inhibition are not proved; keep stopped and inhibited.")


def bounded_default(argv):
    """Bound the two fixed read commands by time and bytes, including stderr."""
    with subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}) as child:
        output = {child.stdout: bytearray(), child.stderr: bytearray()}
        try:
            with selectors.DefaultSelector() as poll:
                for stream in output:
                    poll.register(stream, selectors.EVENT_READ)
                deadline = time.monotonic() + 10
                while poll.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        _refuse()
                    for key, _ in poll.select(min(remaining, 0.2)):
                        stream = key.fileobj
                        block = os.read(stream.fileno(), 4096)
                        if not block:
                            poll.unregister(stream)
                            continue
                        output[stream].extend(block)
                        if len(output[stream]) > (16384 if stream is child.stdout else 256):
                            _refuse()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    _refuse()
                code = child.wait(timeout=remaining)
                return subprocess.CompletedProcess(argv, code, bytes(output[child.stdout]), bytes(output[child.stderr]))
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()


def _unique(pairs):
    """Reject duplicate JSON authority fields rather than letting the last win."""
    result = {}
    for key, value in pairs:
        if key in result:
            _refuse()
        result[key] = value
    return result


class SystemdMaintenance:
    """Observe one fixed service and its complete failure domain without effects."""

    def __init__(self, replacement_id, *, root=Path("/"), run_command=bounded_default):
        """Store selectors only; construction performs no host observation or write."""
        self.identifier = replacement_id
        self.root = Path(root)
        self.run_command = run_command

    @contextmanager
    def _directory(self, logical, *, absent=False, config=False):
        """Pin all ancestors without following links; distinguish absence from bad facts."""
        with ExitStack() as handles:
            fd = os.open("/", _DIRECTORY)
            handles.callback(os.close, fd)
            parts = self.root.parts[1:] + Path(logical).parts[1:]
            for component in parts:
                try:
                    fd = os.open(component, _DIRECTORY, dir_fd=fd)
                except FileNotFoundError:
                    if absent:
                        yield None
                        return
                    raise
                handles.callback(os.close, fd)
                # Host parents below the injected root must be private to the
                # operator principal. The /home test-root ancestors are not host configuration.
                if config and component in Path(logical).parts[1:]:
                    info = os.fstat(fd)
                    if (info.st_uid, info.st_gid) != (os.geteuid(), os.getegid()) or info.st_mode & 0o022:
                        _refuse()
            yield fd

    def _read(self, parent, name, limit, *, guard=False):
        """Read stable non-following regular facts, including zero-size kernel files."""
        fd = os.open(name, _FILE, dir_fd=parent)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode):
                _refuse()
            if guard and (stat.S_IMODE(before.st_mode) != 0o644 or
                          (before.st_uid, before.st_gid) != (os.geteuid(), os.getegid())):
                _refuse()
            data = bytearray()
            while block := os.read(fd, min(4096, limit + 1 - len(data))):
                data.extend(block)
                if len(data) > limit:
                    _refuse()
            after = os.fstat(fd)
            named = os.stat(name, dir_fd=parent, follow_symlinks=False)
            def identity(info):
                return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                        info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            if identity(before) != identity(after) or identity(after) != identity(named):
                _refuse()
            return bytes(data)
        finally:
            os.close(fd)

    def _query(self, argv):
        """Require exact bounded successful tool results; stderr is not ignored."""
        result = self.run_command(argv)
        if (type(result.returncode) is not int or result.returncode != 0 or
                type(result.stdout) is not bytes or len(result.stdout) > 16384 or
                type(result.stderr) is not bytes or result.stderr):
            _refuse()
        return result.stdout.decode("utf-8", errors="strict")

    def _service(self):
        """Admit only named current service facts; refresh after kernel observations."""
        output = self._query(["/usr/bin/systemctl", "show", "--no-pager", "--all",
                              "--property=" + ",".join(_PROPERTIES), _UNIT])
        facts = {}
        for line in output.splitlines():
            key, separator, value = line.partition("=")
            if not separator or key not in _PROPERTIES or key in facts:
                _refuse()
            facts[key] = value
        expected = {"MainPID": "0", "ActiveState": "inactive", "SubState": "dead",
                    "Slice": "openkit-nanohost.slice", "Restart": "no",
                    "DropInPaths": self.guard, "FragmentPath": _FRAGMENT, "LoadState": "loaded"}
        if set(facts) != set(_PROPERTIES) or any(facts[key] != value for key, value in expected.items()):
            _refuse()
        if facts["ControlGroup"] not in ("", _GROUP) or facts["NeedDaemonReload"] not in ("yes", "no"):
            _refuse()
        return facts

    def _guard(self):
        """Require loaded guard's persistent exact bytes and absent non-followed permit."""
        directory = _FRAGMENT + ".d"
        with self._directory(directory, config=True) as fd:
            expected = ("[Unit]\nConditionPathExists=" + self.permit + "\n[Service]\nRestart=no\n").encode()
            if self._read(fd, Path(self.guard).name, 4096, guard=True) != expected:
                _refuse()
            try:
                os.stat(Path(self.permit).name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                _refuse()
        # These are counterexample checks, not a complete manager UnitPath
        # admission. The operator entry must inspect the actual full search path.
        for base in ("/etc/systemd/system", "/run/systemd/system", "/usr/lib/systemd/system"):
            for suffix in (_UNIT + ".d", "openkit-.service.d", "service.d"):
                logical = base + "/" + suffix
                with self._directory(logical, absent=True, config=True) as fd:
                    if fd is not None:
                        for name in os.listdir(fd):
                            if name.endswith(".conf") and logical + "/" + name != self.guard:
                                _refuse()

    def _conditions(self):
        """Read typed effective conditions, not systemctl's ambiguous display string."""
        raw = self._query(["/usr/bin/busctl", "--system", "--json=short", "get-property",
                           "org.freedesktop.systemd1", "/org/freedesktop/systemd1/unit/openkit_2dnanohost_2eservice",
                           "org.freedesktop.systemd1.Unit", "Conditions"])
        value = json.loads(raw, object_pairs_hook=_unique)
        if type(value) is not dict or set(value) != {"type", "data"} or value["type"] != "a(sbbsi)":
            _refuse()
        entries = value["data"]
        if type(entries) is not list or len(entries) != 1 or type(entries[0]) is not list or len(entries[0]) != 5:
            _refuse()
        name, trigger, negate, parameter, history = entries[0]
        if (name != "ConditionPathExists" or type(trigger) is not bool or trigger or
                type(negate) is not bool or negate or parameter != self.permit or
                type(history) is not int or history not in (-1, 0, 1)):
            _refuse()

    def _domain(self):
        """Require every current v2 descendant empty within finite observation bounds."""
        with self._directory("/sys/fs/cgroup") as anchor:
            self._read(anchor, "cgroup.controllers", 4096)
        count = 0
        observed = {}
        def visit(logical, depth):
            nonlocal count
            count += 1
            if count > 256 or depth > 16:
                _refuse()
            with self._directory(logical) as fd:
                info = os.fstat(fd)
                events = self._read(fd, "cgroup.events", 4096).decode("ascii")
                values = {}
                for line in events.splitlines():
                    pair = line.split()
                    if len(pair) != 2 or pair[0] in values or pair[1] not in ("0", "1"):
                        _refuse()
                    values[pair[0]] = pair[1]
                if values.get("populated") != "0" or self._read(fd, "cgroup.procs", 4096).strip():
                    _refuse()
                names = []
                for name in os.listdir(fd):
                    item = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    if stat.S_ISLNK(item.st_mode):
                        _refuse()
                    if stat.S_ISDIR(item.st_mode):
                        names.append(name)
                observed[logical] = (info.st_dev, info.st_ino, tuple(sorted(names)))
                for name in names:
                    visit(logical + "/" + name, depth + 1)
                current = os.fstat(fd)
                if (info.st_dev, info.st_ino, info.st_mtime_ns) != (current.st_dev, current.st_ino, current.st_mtime_ns):
                    _refuse()
        with self._directory(_DOMAIN, absent=True) as fd:
            if fd is None:
                return None
        visit(_DOMAIN, 0)
        return observed

    def assert_fenced_and_inhibited(self):
        """Refresh guard, service and full-domain facts; any contradiction refuses."""
        try:
            if (type(self.identifier) is not str or str(uuid.UUID(self.identifier)) != self.identifier or
                    not self.root.is_absolute() or ".." in self.root.parts):
                _refuse()
            self.guard = _FRAGMENT + ".d/zz-openkit-replacement-" + self.identifier + ".conf"
            self.permit = _FRAGMENT + ".d/.openkit-replacement-" + self.identifier + ".permit"
            before = self._service()
            self._guard()
            domain = self._domain()
            self._conditions()
            if before != self._service():
                _refuse()
            self._guard()
            if domain != self._domain():
                _refuse()
        except Exception:
            _refuse()
