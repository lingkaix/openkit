"""Fixed root bootstrap for one explicitly selected external operator invocation.

The internal frame is not a public command API. Only the current checkout adapter supplies code, and no parameter file can choose code, commands, services or host paths.

Unknown completion retains all archive, source, maintenance and recovery custody for inspection.
"""

from contextlib import ExitStack
from datetime import datetime
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import stat
import struct
import subprocess
import sys
import time
import uuid
from urllib.parse import urlsplit

_SOURCES = {"host-procedure.py", "nanohost-maintenance.py", "nanohost-systemd.py", "nanohost-replacement.py"}
_ACTIONS = {"preflight", "begin", "vacate", "install", "start", "finalize"}
_MAX_ARCHIVE = 536870912
_DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
_FAILURE = "Operator host input or observation unavailable; inspect custody before any new effect."
_REASONS = {"request", "machine-binding", "runtime-directory", "verified-archive", "retained-inputs", "canonical-systemd-posture", "target-host-check", "maintenance-inhibition", "old-payload-custody", "target-installation", "controlled-start", "controlled-inspection", "supervision-restoration", "native-inspection"}

_IDENTITY_REASONS = {"machine-binding", "app-helper-identity", "canonical-docker-posture", "app-web-attribution"}


class IdentityRefusal(Exception):
    """Expose only a fixed prerequisite category from this trusted identity reader."""

    def __init__(self, reason):
        super().__init__(_FAILURE)
        self.reason = reason


def _need(condition):
    """Refuse without copying private host data or operating-system diagnostics."""
    if not condition:
        raise ValueError(_FAILURE)


def _unique(pairs):
    """Reject duplicate authority keys before interpreting a JSON envelope."""
    result = {}
    for key, value in pairs:
        _need(key not in result)
        result[key] = value
    return result


def _json(data):
    """Decode one strict UTF-8 JSON value with unique keys at every level."""
    return json.loads(data.decode("utf-8"), object_pairs_hook=_unique, parse_constant=lambda _value: _need(False))


def _hex(value, length=64):
    """Require an exact lowercase content identity."""
    return type(value) is str and re.fullmatch(r"[a-f0-9]{" + str(length) + "}", value) is not None


def _uuid(value):
    """UUIDs cannot select paths beyond the fixed operation-owned name."""
    _need(type(value) is str and str(uuid.UUID(value)) == value)


def _attribution(value):
    """Admit only the existing archive attribution core, never a host selector."""
    _need(type(value) is dict and set(value) == {"archiveSha256", "tag", "sourceCommit", "platform", "payloads"})
    _need(_hex(value["archiveSha256"]) and _hex(value["sourceCommit"], 40))
    _need(type(value["tag"]) is str and re.fullmatch(r"v\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?", value["tag"]))
    _need(value["platform"] in ("linux/amd64", "linux/arm64"))
    _need(type(value["payloads"]) is dict and set(value["payloads"]) == {"nanohostSha256", "gatewaySha256", "unitFileSha256"})
    _need(all(_hex(item) for item in value["payloads"].values()))


def _header(value):
    """Validate the two fixed internal calls before opening any host custody."""
    _need(type(value) is dict and value.get("kind") in ("identity", "nanohost-step", "controlled-observation"))
    binding = value.get("binding")
    _need(type(binding) is dict and set(binding) == {"origin", "container", "machineId", "machineIdentityDigest"})
    _need(type(binding["origin"]) is str)
    origin = urlsplit(binding["origin"])
    _need(origin.scheme == "https" and origin.hostname and not origin.username and not origin.password and not origin.path and not origin.query and not origin.fragment and origin.geturl() == binding["origin"])
    origin.port
    _need(type(binding["container"]) is str and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", binding["container"]))
    _need(_hex(binding["machineId"], 32) and _hex(binding["machineIdentityDigest"]))
    if value["kind"] == "identity":
        _need(set(value) == {"kind", "binding", "helperSha256", "app"} and _hex(value["helperSha256"]))
        app = value["app"]
        if app is not None:
            _need(type(app) is dict and set(app) == {"requestId", "source", "configDigest"})
            _uuid(app["requestId"])
            _need(type(app["source"]) is dict and set(app["source"]) == {"tag", "sourceCommit", "appDigest"})
            _need(_hex(app["source"]["sourceCommit"], 40) and type(app["source"]["tag"]) is str)
            _need(re.fullmatch(r"sha256:[a-f0-9]{64}", app["source"]["appDigest"]) and re.fullmatch(r"sha256:[a-f0-9]{64}", app["configDigest"]))
        return value
    _need(set(value) == {"kind", "binding", "request", "sources", "archive", "containerId", "imageConfigDigest"} | ({"controlledProcess"} if value["kind"] == "controlled-observation" else set()))
    _need(_hex(value["containerId"]) and type(value["imageConfigDigest"]) is str and re.fullmatch(r"sha256:[a-f0-9]{64}", value["imageConfigDigest"]))
    request = value["request"]
    _need(type(request) is dict and request.get("action") in _ACTIONS)
    _need(set(request) == {"action", "replacementId", "old", "target"} | ({"process"} if request["action"] == "finalize" else set()))
    _uuid(request["replacementId"])
    for kind in ("old", "target"):
        _attribution(request[kind])
    _need(request["old"]["platform"] == request["target"]["platform"])
    if request["action"] == "finalize":
        process = request["process"]
        _need(type(process) is dict and set(process) == {"bootId", "pid", "startTimeTicks"})
        _uuid(process["bootId"])
        _need(type(process["pid"]) is int and 0 < process["pid"] <= 2147483647)
        _need(type(process["startTimeTicks"]) is str and re.fullmatch(r"[1-9][0-9]{0,19}", process["startTimeTicks"]) and int(process["startTimeTicks"]) <= 18446744073709551615)
    if value["kind"] == "controlled-observation":
        _need(request["action"] == "start")
        process = value["controlledProcess"]
        _need(type(process) is dict and set(process) == {"bootId", "pid", "startTimeTicks"})
        _uuid(process["bootId"])
        _need(type(process["pid"]) is int and 0 < process["pid"] <= 2147483647 and type(process["startTimeTicks"]) is str and re.fullmatch(r"[1-9][0-9]{0,19}", process["startTimeTicks"]) and int(process["startTimeTicks"]) <= 18446744073709551615)
    sources = value["sources"]
    _need(type(sources) is dict and set(sources) == _SOURCES)
    _need(all(type(code) is str and 0 < len(code.encode("utf-8")) <= 131072 for code in sources.values()))
    archive = value["archive"]
    target = request["target"]
    name = "openkit-nanohost-" + target["tag"] + "-" + target["platform"].replace("/", "-") + ".tar.gz"
    _need(type(archive) is dict and set(archive) == {"name", "size", "sha256"})
    _need(archive["name"] == name and archive["sha256"] == target["archiveSha256"] and type(archive["size"]) is int and 0 < archive["size"] <= _MAX_ARCHIVE)
    return value


def _identity(info):
    """Select stable object identity, ownership and byte metadata."""
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _directory(path, stack, owner=0):
    """Pin every root-owned non-writable ancestor; verification may supply a disposable parent."""
    path = Path(path)
    _need(path.is_absolute() and ".." not in path.parts and str(path) == os.path.normpath(str(path)))
    fd = os.open("/", _DIRECTORY)
    stack.callback(os.close, fd)
    for part in path.parts[1:]:
        fd = os.open(part, _DIRECTORY, dir_fd=fd)
        stack.callback(os.close, fd)
        info = os.fstat(fd)
        _need(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, owner) and not info.st_mode & 0o022)
    return fd


def _file(parent, name, *, mode=None, limit=1048576, owner=0):
    """Read bounded stable private bytes through the pinned non-following parent."""
    fd = os.open(name, _FILE, dir_fd=parent)
    try:
        before = os.fstat(fd)
        _need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and (before.st_uid, before.st_gid) == (owner, os.getegid() if owner else 0) and not before.st_mode & 0o022 and before.st_size <= limit and (mode is None or stat.S_IMODE(before.st_mode) == mode))
        data = bytearray()
        while len(data) <= limit:
            block = os.read(fd, min(65536, limit + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        _need(len(data) <= limit and _identity(before) == _identity(os.fstat(fd)) == _identity(os.stat(name, dir_fd=parent, follow_symlinks=False)))
        return bytes(data)
    finally:
        os.close(fd)


def _regular(path, *, limit, mode=None):
    """Observe one fixed protected root file without following a parent or final link."""
    with ExitStack() as stack:
        parent = _directory(Path(path).parent, stack)
        return _file(parent, Path(path).name, limit=limit, mode=mode)


def _read(fd, length, deadline):
    """Bound input time and bytes together; incomplete framing never authorizes an effect."""
    result = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(fd, selectors.EVENT_READ)
        while len(result) < length:
            remaining = deadline - time.monotonic()
            _need(remaining > 0 and selector.select(remaining))
            chunk = os.read(fd, min(65536, length - len(result)))
            _need(chunk)
            result.extend(chunk)
    return bytes(result)


def _eof(fd, deadline):
    """Reject trailing bytes, including an archive attached to a later stage."""
    with selectors.DefaultSelector() as selector:
        selector.register(fd, selectors.EVENT_READ)
        remaining = deadline - time.monotonic()
        _need(remaining > 0 and selector.select(remaining) and os.read(fd, 1) == b"")


def _custody(header, archive_reader, *, parent=Path("/usr/lib/openkit"), owner=0):
    """Create once or compare exact fixed custody; injected parents are for contained verification only."""
    request = header["request"]
    name = ".openkit-operator-input-" + request["replacementId"]
    workspace = parent / name
    with ExitStack() as stack:
        parent_fd = _directory(parent, stack, owner)
        if request["action"] == "preflight":
            os.mkdir(name, mode=0o700, dir_fd=parent_fd)
            os.fsync(parent_fd)
        fd = os.open(name, _DIRECTORY, dir_fd=parent_fd)
        stack.callback(os.close, fd)
        info = os.fstat(fd)
        _need(stat.S_IMODE(info.st_mode) == 0o700 and (info.st_uid, info.st_gid) == (owner, os.getegid() if owner else 0))
        for filename, code in header["sources"].items():
            expected = code.encode("utf-8")
            if request["action"] == "preflight":
                out = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644, dir_fd=fd)
                try:
                    os.fchmod(out, 0o644)
                    view = memoryview(expected)
                    while view:
                        view = view[os.write(out, view):]
                    os.fsync(out)
                finally:
                    os.close(out)
            _need(_file(fd, filename, mode=0o644, limit=131072, owner=owner) == expected)
        archive = header["archive"]
        if request["action"] == "preflight":
            out = os.open(archive["name"], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=fd)
            try:
                digest = hashlib.sha256()
                remaining = archive["size"]
                while remaining:
                    block = archive_reader(min(65536, remaining))
                    _need(type(block) is bytes and 0 < len(block) <= remaining)
                    remaining -= len(block)
                    digest.update(block)
                    view = memoryview(block)
                    while view:
                        view = view[os.write(out, view):]
                _need(digest.hexdigest() == archive["sha256"])
                os.fsync(out)
            finally:
                os.close(out)
        archive_fd = os.open(archive["name"], _FILE, dir_fd=fd)
        try:
            before = os.fstat(archive_fd)
            _need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and stat.S_IMODE(before.st_mode) == 0o600 and (before.st_uid, before.st_gid) == (owner, os.getegid() if owner else 0) and before.st_size == archive["size"])
            digest = hashlib.sha256()
            remaining = archive["size"]
            while remaining:
                block = os.read(archive_fd, min(1048576, remaining))
                _need(block)
                digest.update(block)
                remaining -= len(block)
            _need(os.read(archive_fd, 1) == b"" and digest.hexdigest() == archive["sha256"] and _identity(before) == _identity(os.fstat(archive_fd)) == _identity(os.stat(archive["name"], dir_fd=fd, follow_symlinks=False)))
        finally:
            os.close(archive_fd)
        os.fsync(fd)
        os.fsync(parent_fd)
        _need(_identity(info)[:5] == _identity(os.stat(name, dir_fd=parent_fd, follow_symlinks=False))[:5])
    return workspace


def _docker(name, image=False):
    """Collect only one fixed Docker identity read with bounded bytes and duration."""
    _need(type(name) is str and (re.fullmatch(r"sha256:[a-f0-9]{64}", name) if image else re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", name)))
    argv = ["/usr/bin/docker", *( ["image"] if image else []), "inspect", "--format", "{{json .}}", name]
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    output = bytearray()
    errors = bytearray()
    deadline = time.monotonic() + 30
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, output)
            selector.register(child.stderr, selectors.EVENT_READ, errors)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                _need(remaining > 0)
                events = selector.select(remaining)
                _need(events)
                for key, _ in events:
                    block = os.read(key.fd, 65536)
                    if not block:
                        selector.unregister(key.fileobj)
                        continue
                    key.data.extend(block)
                    _need(len(output) <= 1048576 and len(errors) <= 256)
        _need(child.wait(timeout=max(0.001, deadline - time.monotonic())) == 0 and not errors)
        return _json(bytes(output))
    finally:
        if child.poll() is None:
            os.killpg(child.pid, 9)
            child.wait(timeout=1)
        child.stdout.close()
        child.stderr.close()


def _physical(binding):
    """Reconcile the retained raw App ID with SHA-256 of the exact machine-file bytes."""
    machine = _regular(Path("/etc/machine-id"), limit=128)
    actual = machine.decode("ascii").strip()
    _need(_hex(actual, 32) and actual == binding["machineId"] and hashlib.sha256(machine).hexdigest() == binding["machineIdentityDigest"])
    return actual


def _container_stamp(container, name):
    """Bind the actual named Docker incarnation without retaining its configuration or environment."""
    state = container.get("State", {})
    _need(container.get("Name") == "/" + name and _hex(container.get("Id")) and type(container.get("Image")) is str and re.fullmatch(r"sha256:[a-f0-9]{64}", container["Image"]))
    _need(state.get("Running") is True and type(state.get("Pid")) is int and 0 < state["Pid"] <= 2147483647 and type(state.get("StartedAt")) is str and state["StartedAt"].endswith("Z"))
    datetime.fromisoformat(state["StartedAt"].replace("Z", "+00:00"))
    return (container["Id"], container["Image"], state["Pid"], state["StartedAt"])


def _host_identity(header):
    """Observe canonical Docker posture and optionally the exact successful helper Web tree."""
    phase = "machine-binding"
    try:
        binding = header["binding"]
        machine = _physical(binding)
        phase = "app-helper-identity"
        helper_path = Path("/usr/local/lib/openkit/app-update-helper.py")
        helper_bytes = _regular(helper_path, limit=1048576)
        _need(hashlib.sha256(helper_bytes).hexdigest() == header["helperSha256"])
        spec = importlib.util.spec_from_file_location("openkit_installed_app_helper", helper_path)
        helper = importlib.util.module_from_spec(spec)
        exec(compile(helper_bytes, str(helper_path), "exec"), helper.__dict__)
        _need(helper.HELPER_SHA256 == header["helperSha256"])
        config_bytes = _regular(Path(helper.PRODUCTION_CONFIG_PATH), limit=65536, mode=0o600)
        _json(config_bytes)
        config = helper.load_config(helper.PRODUCTION_CONFIG_PATH, require_compatibility=False)
        phase = "canonical-docker-posture"
        _need(config["containerName"] == binding["container"])
        container = _docker(binding["container"])
        incarnation = _container_stamp(container, binding["container"])
        image_id = container.get("Image")
        _need(type(image_id) is str and re.fullmatch(r"sha256:[a-f0-9]{64}", image_id))
        image = _docker(image_id, image=True)
        _need(image.get("Id") == image_id)
        # Reuse the checksum-pinned helper's canonical deployment predicate without its directory-creating constructor.
        checker = object.__new__(helper.AppUpdateHelper)
        checker.config = config
        checker._assert_configured_deployment_bindings(container, {"entrypoint": list(image.get("Config", {}).get("Entrypoint") or []), "cmd": list(image.get("Config", {}).get("Cmd") or [])})
        _need(_hex(container.get("Id")))
        result = {"outcome": "observed", "machineId": machine, "machineIdentityDigest": binding["machineIdentityDigest"], "container": binding["container"], "containerId": container["Id"], "appImageId": image_id, "helperSha256": header["helperSha256"]}
        app = header["app"]
        if app is not None:
            phase = "app-web-attribution"
            _need(image_id == app["configDigest"])
            receipt_path = Path(config["receiptDir"]) / (app["requestId"] + ".json")
            receipt_bytes = _regular(receipt_path, limit=65536, mode=0o600)
            receipt = _json(receipt_bytes)
            observed_source = receipt.get("source")
            _need(type(observed_source) is dict and {key: observed_source.get(key) for key in ("tag", "sourceCommit", "appDigest")} == app["source"] and receipt.get("requestId") == app["requestId"] and receipt.get("stage") == "succeeded" and receipt.get("preparedHelperSha256") == header["helperSha256"])
            boot = receipt.get("candidateBoot")
            _need(type(boot) is dict and boot.get("imageId") == image_id and boot.get("sourceCommit") == app["source"]["sourceCommit"] and type(boot.get("bootId")) is str and re.fullmatch(r"boot_[a-fA-F0-9-]{36}", boot["bootId"]))
            _need(str(uuid.UUID(boot["bootId"][5:])) == boot["bootId"][5:].lower())
            expected = receipt.get("webStagedDigest")
            _need(type(expected) is str and re.fullmatch(r"sha256:[a-f0-9]{64}", expected))
            web = Path(config["webAssetsDir"])
            with ExitStack() as stack:
                _directory(web, stack)
                current = web / "current"
                _need(current.is_symlink())
                resolved = Path(os.path.realpath(current))
                _need(resolved.parent == web)
                _directory(resolved, stack)
                measured = helper.digest_tree(str(resolved))
                _need(measured == expected and Path(os.path.realpath(current)) == resolved)
            _need(_regular(receipt_path, limit=65536, mode=0o600) == receipt_bytes)
            result.update(requestId=app["requestId"], source=app["source"], candidateBoot={key: boot[key] for key in ("bootId", "imageId", "sourceCommit")}, webTreeDigest=measured, webStagedDigest=expected)
        phase = "app-helper-identity"
        _need(_regular(Path(helper.PRODUCTION_CONFIG_PATH), limit=65536, mode=0o600) == config_bytes and _regular(helper_path, limit=1048576) == helper_bytes)
        phase = "machine-binding"
        _need(_physical(binding) == machine)
        phase = "canonical-docker-posture"
        again = _docker(binding["container"])
        _need(_container_stamp(again, binding["container"]) == incarnation)
        checker._assert_configured_deployment_bindings(again, {"entrypoint": list(image.get("Config", {}).get("Entrypoint") or []), "cmd": list(image.get("Config", {}).get("Cmd") or [])})
        return result
    except Exception:
        raise IdentityRefusal(phase) from None


def main():
    """Read one finite frame, perform one fixed call, and emit no private failure detail."""
    module = None
    header = None
    try:
        deadline = time.monotonic() + 180
        length = struct.unpack(">I", _read(0, 4, deadline))[0]
        _need(0 < length <= 262144)
        header = _header(_json(_read(0, length, deadline)))
        _need(os.geteuid() == 0 and os.getegid() == 0)
        if header["kind"] == "identity":
            _eof(0, deadline)
            result = _host_identity(header)
        else:
            _physical(header["binding"])
            container = _docker(header["binding"]["container"])
            incarnation = _container_stamp(container, header["binding"]["container"])
            _need(container.get("Id") == header["containerId"] and container.get("Image") == header["imageConfigDigest"])
            workspace = _custody(header, lambda size: _read(0, size, deadline))
            _eof(0, deadline)
            spec = importlib.util.spec_from_file_location("openkit_operator_procedure", workspace / "host-procedure.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            if header["kind"] == "controlled-observation":
                result = module.run_step(header["request"], workspace, header["binding"]["machineIdentityDigest"], controlled_process=header["controlledProcess"])
            else:
                result = module.run_step(header["request"], workspace, header["binding"]["machineIdentityDigest"])
            again = _docker(header["binding"]["container"])
            _need(_container_stamp(again, header["binding"]["container"]) == incarnation)
        output = json.dumps(result, separators=(",", ":")).encode("utf-8")
        _need(len(output) + 1 <= 16384)
        view = memoryview(output + b"\n")
        while view:
            view = view[os.write(1, view):]
        return 0
    except Exception as error:
        try:
            reason = getattr(error, "reason", None)
            if isinstance(error, IdentityRefusal) and type(reason) is str and reason in _IDENTITY_REASONS:
                output = {"action": "identity", "outcome": "unavailable", "reason": reason}
                os.write(1, json.dumps(output, separators=(",", ":")).encode() + b"\n")
                return 1
            refusal = getattr(module, "ProcedureRefusal", None)
            if isinstance(refusal, type) and isinstance(error, refusal) and type(reason) is str and reason in _REASONS:
                output = {"action": header["request"]["action"], "outcome": "unavailable", "reason": reason}
                os.write(1, json.dumps(output, separators=(",", ":")).encode() + b"\n")
                return 1
        except Exception:
            pass
        try:
            os.write(2, (_FAILURE + "\n").encode())
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
