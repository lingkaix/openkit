"""Fixed host steps for the explicitly invoked external operator procedure.

The transport supplies an exclusive private archive custody directory, verified
source bytes and the retained machine binding. It does not install this program
as a service. Any error retains custody and inhibition for explicit inspection.
No request can select a command, service, filesystem root or live destination.
"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import stat
import uuid


def _load(name):
    """Load only adjacent procedure sources selected by the operator checkout."""
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_maintenance = _load("nanohost-maintenance")
_replacement = _load("nanohost-replacement")
_systemd = _load("nanohost-systemd")
_ACTIONS = {"preflight", "begin", "vacate", "install", "start", "finalize"}
_PATH_KEYS = (
    "OPENKIT_NANOHOST_TOKEN_SLOT_A_SECRET_FILE", "OPENKIT_NANOHOST_TOKEN_SLOT_A_COMPANION_FILE",
    "OPENKIT_NANOHOST_TOKEN_SLOT_B_SECRET_FILE", "OPENKIT_NANOHOST_TOKEN_SLOT_B_COMPANION_FILE",
    "OPENKIT_NANOHOST_NANOCORE_CA_FILE",
)


class ProcedureRefusal(Exception):
    """Closed refusal; no host exception, private path or child output escapes."""


def _need(condition):
    """Keep unknown host facts local and stop before the next dependent effect."""
    if not condition:
        raise ProcedureRefusal("NanoHost operator step unavailable; inspect retained custody before any new effect.")


def _sha(data):
    """Compute a non-secret content identity or a private in-memory comparison."""
    return hashlib.sha256(data).hexdigest()


def _request(value):
    """Admit the finite procedure, three payload identities and canonical UUID."""
    _need(type(value) is dict and value.get("action") in _ACTIONS)
    keys = {"action", "replacementId", "old", "target"}
    if value["action"] == "finalize":
        keys.add("process")
        _maintenance._stamp(value.get("process"))
    _need(set(value) == keys)
    identifier = value["replacementId"]
    _need(type(identifier) is str and str(uuid.UUID(identifier)) == identifier)
    for kind in ("old", "target"):
        raw = value[kind]
        _need(type(raw) is dict and set(raw) == {"archiveSha256", "tag", "sourceCommit", "platform", "payloads"})
        _need(type(raw["tag"]) is str and re.fullmatch(r"v\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?", raw["tag"]))
        _need(type(raw["sourceCommit"]) is str and re.fullmatch(r"[a-f0-9]{40}", raw["sourceCommit"]))
        _need(raw["platform"] in ("linux/amd64", "linux/arm64"))
        _maintenance._hash(raw["archiveSha256"])
        _need(type(raw["payloads"]) is dict and set(raw["payloads"]) == {"nanohostSha256", "gatewaySha256", "unitFileSha256"})
        for digest in raw["payloads"].values():
            _maintenance._hash(digest)
    _need(value["old"]["platform"] == value["target"]["platform"])
    return identifier


def _payloads(attribution):
    """Translate the existing archive projection to the custody owner's keys."""
    raw = attribution["payloads"]
    return {"nanohost": raw["nanohostSha256"], "gateway": raw["gatewaySha256"], "unit": raw["unitFileSha256"]}


def _run(argv, *, input_bytes=None, timeout_seconds=10, max_stdout_bytes=16384, max_stderr_bytes=256):
    """Reuse one bounded subprocess collector; never return raw stderr to evidence."""
    result = _systemd.bounded_default(argv, input_bytes=input_bytes, timeout_seconds=timeout_seconds,
                                     max_stdout_bytes=max_stdout_bytes, max_stderr_bytes=max_stderr_bytes)
    _need(result.returncode == 0 and not result.stderr)
    return result.stdout


def _regular(path, *, limit, mode=None):
    """Read stable root-owned regular bytes without following a final link."""
    with _replacement._root(Path("/")) as root:
        with _replacement._parent(root, str(path.parent).lstrip("/")) as parent:
            fd = os.open(path.name, _replacement._FILE, dir_fd=parent)
            try:
                before = os.fstat(fd)
                _need(stat.S_ISREG(before.st_mode) and (before.st_uid, before.st_gid) == (0, 0)
                      and not before.st_mode & 0o022 and before.st_size <= limit
                      and (mode is None or stat.S_IMODE(before.st_mode) == mode))
                data = bytearray()
                while len(data) <= limit:
                    block = os.read(fd, min(65536, limit + 1 - len(data)))
                    if not block:
                        break
                    data.extend(block)
                after = os.fstat(fd)
                identity = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                                         info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                _need(len(data) <= limit and identity(before) == identity(after)
                      and identity(after) == identity(os.stat(path.name, dir_fd=parent, follow_symlinks=False)))
                return bytes(data), identity(after)
            finally:
                os.close(fd)


def _inputs():
    """Observe a supported plain environment file and named inputs only in memory.

    Secret bytes, their hashes and input paths never enter the returned evidence
    digest. Private hashes are used only to compare the unchanged install window.
    Other valid systemd environment syntax needs the manual operator procedure.
    """
    data, identity = _regular(Path("/etc/openkit/nanohost.env"), limit=65536, mode=0o600)
    values = {}
    for line in data.decode("utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        _need(separator and re.fullmatch(r"[A-Z][A-Z0-9_]*", key) and key not in values
              and value and not any(character.isspace() or character in "'\"\\" for character in value))
        values[key] = value
    required = {"OPENKIT_NANOHOST_IDENTITY_ID", "OPENKIT_NANOHOST_DEPLOYMENT_ID",
                "OPENKIT_NANOHOST_NANOCORE_RENDEZVOUS_URL", *_PATH_KEYS[:4]}
    _need(required <= set(values) and set(values) <= required | {_PATH_KEYS[4]})
    private = [(identity, _sha(data))]
    metadata = []
    for key in _PATH_KEYS:
        if key not in values:
            continue
        path = Path(values[key])
        _need(path.is_absolute() and ".." not in path.parts and str(path) == values[key])
        content, stamp = _regular(path, limit=1048576)
        private.append((stamp, _sha(content)))
        metadata.append(stamp)
    public = _sha(json.dumps([_sha(data), identity, metadata], separators=(",", ":")).encode())
    return public, private


def _volatile_run():
    """Refuse a permit location that can survive a fresh boot."""
    lines = Path("/proc/self/mountinfo").read_text().splitlines()
    matches = [line.split() for line in lines if len(line.split()) > 6 and line.split()[4] == "/run"]
    _need(len(matches) == 1)
    entry = matches[0]
    separator = entry.index("-")
    _need(entry[separator + 1] == "tmpfs")


def _stock(manager, unit_hash):
    """Accept the canonical full live posture before measuring its native digest."""
    manager._admit()
    manager._unit_roots(False)
    manager._activation()
    manager._old_unit(unit_hash)
    _need(manager._bus("Conditions", "a(sbbsi)") == [])
    return manager._incarnation(False)


def _inspection(process, attribution, manager, *, guarded=False):
    """Measure once after actual readiness; unavailable evidence is never refreshed."""
    _need(manager._incarnation(guarded) == process)
    nonce = secrets.token_hex(32)
    raw = _run(["/usr/lib/openkit/nanohost", "inspect"], input_bytes=json.dumps({"nonce": nonce}).encode())
    result = json.loads(raw, object_pairs_hook=_systemd._unique)
    _need(result.get("outcome") == "observed" and result.get("nonce") == nonce
          and result.get("coordinator") == process and result.get("replacementDuringMeasurement") is False
          and result.get("executables", {}).get("nanohost", {}).get("sha256") == attribution["payloads"]["nanohostSha256"]
          and result.get("executables", {}).get("gateway", {}).get("sha256") == attribution["payloads"]["gatewaySha256"]
          and result.get("unit", {}).get("fileSha256") == attribution["payloads"]["unitFileSha256"])
    digest = result["unit"].get("effectiveStateDigest")
    _maintenance._hash(digest)
    return digest


def run_step(request, workspace, machine_identity_digest, *, controlled_process=None):
    """Run one fixed admitted step; callers must not replay an unknown result.

    workspace is exclusively created archive custody selected by the fixed
    transport bootstrap, never an instruction field. Tests may replace only
    external observations; this entry always addresses the actual host root.
    """
    try:
        identifier = _request(request)
        if controlled_process is not None:
            _need(request["action"] == "start")
            _maintenance._stamp(controlled_process)
        _need(os.geteuid() == 0 and os.getegid() == 0)
        _maintenance._hash(machine_identity_digest)
        machine, _ = _regular(Path("/etc/machine-id"), limit=128)
        _need(_sha(machine) == machine_identity_digest)
        _volatile_run()
        old, target = request["old"], request["target"]
        name = "openkit-nanohost-" + target["tag"] + "-" + target["platform"].replace("/", "-")
        workspace = Path(workspace)
        _need(workspace == Path("/usr/lib/openkit/.openkit-operator-input-" + identifier))
        archive, _ = _regular(workspace / (name + ".tar.gz"), limit=536870912, mode=0o600)
        _need(_sha(archive) == target["archiveSha256"])
        bundle = workspace / name
        manager = _maintenance.Maintenance(identifier)
        retained, private = _inputs()
        action = request["action"]
        result = {"action": action, "outcome": "passed"}
        if action == "preflight":
            before = _stock(manager, old["payloads"]["unitFileSha256"])
            manager._payloads(_payloads(old))
            _run(["/usr/bin/tar", "-xzf", str(workspace / (name + ".tar.gz")), "-C", str(workspace), "--no-same-owner"], timeout_seconds=180)
            check = json.loads(_run([str(bundle / "install.sh"), "--check-host"], timeout_seconds=180,
                                   max_stdout_bytes=65536, max_stderr_bytes=4096), object_pairs_hook=_systemd._unique)
            _need(check.get("hardVerdict") == "requirements-met" and check.get("archiveSha256") == target["archiveSha256"]
                  and check.get("productCommit") == target["sourceCommit"]
                  and check.get("machineIdentityDigest") == machine_identity_digest)
            _need(before == _stock(manager, old["payloads"]["unitFileSha256"]))
            result.update(posture="canonical-systemd", retainedInputsDigest=retained,
                          stockEffectiveStateDigest=_inspection(before, old, manager))
        elif action == "begin":
            manager.begin(old["payloads"]["unitFileSha256"])
            result.update(fenced=True, inhibited=True)
        elif action == "vacate":
            _replacement.vacate_verified_payloads({"replacementId": identifier, "old": _payloads(old),
                                                   "target": _payloads(target)}, manager)
            result.update(custodyVerified=True, fenced=True, inhibited=True)
        elif action == "install":
            manager.assert_fenced_and_inhibited()
            before = _run([str(bundle / "install.sh"), "--check"], timeout_seconds=180,
                          max_stdout_bytes=65536, max_stderr_bytes=4096).decode("ascii").splitlines()
            _need(len([line for line in before if line.startswith("destination=")]) == 1
                  and any(line in before for line in ("destination=installable", "destination=resumable", "destination=already-installed")))
            manager.assert_fenced_and_inhibited()
            installed = _run([str(bundle / "install.sh")], timeout_seconds=180,
                             max_stdout_bytes=65536, max_stderr_bytes=4096).decode("ascii").splitlines()
            _need(len([line for line in installed if line.startswith("installation=")]) == 1
                  and any(line in installed for line in ("installation=complete", "installation=already-installed"))
                  and installed.count("remaining=configuration,enrollment,service-start") == 1)
            manager.assert_fenced_and_inhibited()
            after = _run([str(bundle / "install.sh"), "--check"], timeout_seconds=180,
                         max_stdout_bytes=65536, max_stderr_bytes=4096).decode("ascii").splitlines()
            _need([line for line in after if line.startswith("destination=")] == ["destination=already-installed"])
            manager.assert_fenced_and_inhibited()
            manager._payloads(_payloads(target))
            result.update(payloads=target["payloads"], retainedInputsDigest=retained, fenced=True, inhibited=True)
        elif action == "start":
            if controlled_process is None:
                # The external adapter next waits on public pending-readiness
                # observations. This command must never be reissued on loss.
                result.update(process=manager.start_once(_payloads(target)))
            else:
                # A separate fixed read-only subphase follows public readiness.
                # It consumes no permit and has no authority to start a process.
                manager._admit()
                manager._unit_roots(True)
                manager._activation()
                manager._guard()
                manager._owned(manager.attempt, manager._attempt_bytes(), 0o644)
                manager._conditions()
                manager._payloads(_payloads(target))
                _need(manager._incarnation(True) == controlled_process)
                result.update(process=controlled_process,
                              controlledEffectiveStateDigest=_inspection(controlled_process, target, manager, guarded=True))
        else:
            process = request["process"]
            manager.finalize(process, _payloads(target))
            _need(_stock(manager, target["payloads"]["unitFileSha256"]) == process)
            result.update(process=process, payloads=target["payloads"], retainedInputsDigest=retained,
                          supervisionRestored=True, effectiveStateDigest=_inspection(process, target, manager))
        _need(_inputs() == (retained, private))
        return result
    except Exception:
        raise ProcedureRefusal("NanoHost operator step unavailable; inspect retained custody before any new effect.") from None
