"""Fixed-destination custody for the external NanoHost operator procedure.

This module does not install, start, restore, resume or modify epoch data. The
operator driver supplies fresh supervisor observations before every vacancy.
The filesystem root is injectable only for contained verification; the eventual
privileged entry always uses the real root and rejects request-selected paths.
"""

from contextlib import ExitStack, contextmanager
import hashlib
import os
from pathlib import Path
import re
import stat
import uuid


_PAYLOADS = {
    "nanohost": ("usr/lib/openkit", "nanohost", ".nanohost.openkit-install", 0o755),
    "gateway": ("usr/lib/openkit", "openshell-gateway", ".openshell-gateway.openkit-install", 0o755),
    "unit": ("etc/systemd/system", "openkit-nanohost.service", ".openkit-nanohost.service.openkit-install", 0o644),
}
_DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK


class ReplacementRefusal(Exception):
    """A closed, non-secret refusal; callers must retain stopped custody."""


def _refuse(reason):
    """Report only a locally authored reason, never an OS path or exception."""
    raise ReplacementRefusal("NanoHost replacement: " + reason + "; keep stopped and inhibited.")


def _request(raw):
    """Admit only fixed logical payload hashes and one canonical custody identifier."""
    if type(raw) is not dict or set(raw) != {"replacementId", "old", "target"}:
        _refuse("invalid custody request")
    identifier = raw["replacementId"]
    if type(identifier) is not str or str(uuid.UUID(identifier)) != identifier:
        _refuse("invalid custody identifier")
    for kind in ("old", "target"):
        values = raw[kind]
        if type(values) is not dict or set(values) != set(_PAYLOADS):
            _refuse("invalid payload identities")
        if any(type(value) is not str or re.fullmatch(r"[a-f0-9]{64}", value) is None for value in values.values()):
            _refuse("invalid payload identities")
    return identifier


def _identity(info):
    """Select retained identity fields; custody links necessarily change ctime and link count."""
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_size, info.st_mtime_ns)


def _owned_directory(fd):
    """Reject writable foreign directories beneath the pinned filesystem root."""
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or (info.st_uid, info.st_gid) != (os.geteuid(), os.getegid()) or info.st_mode & 0o022:
        _refuse("directory ownership conflict")
    return info


@contextmanager
def _root(path):
    """Pin a non-symlink absolute root without resolving through a substituted ancestor."""
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        _refuse("invalid filesystem root")
    with ExitStack() as stack:
        fd = os.open("/", _DIRECTORY)
        stack.callback(os.close, fd)
        for component in path.parts[1:]:
            fd = os.open(component, _DIRECTORY, dir_fd=fd)
            stack.callback(os.close, fd)
        _owned_directory(fd)
        yield fd


@contextmanager
def _parent(root_fd, relative):
    """Open every fixed parent through non-following handles, rather than pathname checks."""
    with ExitStack() as stack:
        fd = root_fd
        for component in relative.split("/"):
            fd = os.open(component, _DIRECTORY, dir_fd=fd)
            stack.callback(os.close, fd)
            _owned_directory(fd)
        yield fd


@contextmanager
def _payload(parent, name, expected_hash, mode):
    """Measure stable regular bytes and metadata through the same open handle."""
    fd = os.open(name, _FILE, dir_fd=parent)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or stat.S_IMODE(before.st_mode) != mode or (before.st_uid, before.st_gid) != (os.geteuid(), os.getegid()):
            _refuse("payload metadata conflict")
        digest = hashlib.sha256()
        while block := os.read(fd, 1024 * 1024):
            digest.update(block)
        after = os.fstat(fd)
        if (_identity(before), before.st_ctime_ns, before.st_nlink) != (_identity(after), after.st_ctime_ns, after.st_nlink) or digest.hexdigest() != expected_hash:
            _refuse("payload identity conflict")
        yield fd, _identity(after)
    finally:
        os.close(fd)


def _reserved(root_fd, target):
    """Preserve exact installer residue and refuse conflicting reserved paths before vacancy."""
    for key, (relative, _, temporary, mode) in _PAYLOADS.items():
        with _parent(root_fd, relative) as parent:
            try:
                os.stat(temporary, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                continue
            with _payload(parent, temporary, target[key], mode):
                pass


def _prerequisite(manager):
    """A past fence or an inactive main PID cannot authorize the next filesystem effect."""
    try:
        manager.assert_fenced_and_inhibited()
    except Exception:
        _refuse("fencing or activation prevention unavailable")


def _remaining(root_fd, request, original, vacated):
    """Recheck named paths after manager observations that can race a path substitution."""
    for key, (relative, name, _, mode) in _PAYLOADS.items():
        if key in vacated:
            continue
        with _parent(root_fd, relative) as parent:
            with _payload(parent, name, request["old"][key], mode) as (_, identity):
                if identity != original[key]:
                    _refuse("live payload changed")
    _reserved(root_fd, request["target"])


def vacate_verified_payloads(request, manager, *, root=Path("/")):
    """Retain only differing old files durably before vacating the three fixed live names.

    The caller owns exclusive maintenance, complete predecessor fencing and
    persistent activation prevention. Every check is refreshed at each vacancy.
    An occupied custody name is never resume authority. Any failure retains all
    created custody and leaves recovery to explicit inspection, without rollback.
    """
    try:
        identifier = _request(request)
        recovery_name = ".openkit-nanohost-replacement-" + identifier
        changed = [key for key in _PAYLOADS if request["old"][key] != request["target"][key]]
        with _root(root) as root_fd, ExitStack() as custody:
            original = {}
            parents = {}
            for key, (relative, name, _, mode) in _PAYLOADS.items():
                with _parent(root_fd, relative) as parent:
                    with _payload(parent, name, request["old"][key], mode) as (_, identity):
                        original[key] = identity
                    # Refuse all occupied operation names before the first move.
                    try:
                        os.stat(recovery_name, dir_fd=parent, follow_symlinks=False)
                    except FileNotFoundError:
                        pass
                    else:
                        _refuse("recovery custody already occupied")
            _reserved(root_fd, request["target"])
            _prerequisite(manager)
            _remaining(root_fd, request, original, set())
            for key in changed:
                relative = _PAYLOADS[key][0]
                if relative in parents:
                    continue
                parent = custody.enter_context(_parent(root_fd, relative))
                os.mkdir(recovery_name, 0o700, dir_fd=parent)
                recovered = os.open(recovery_name, _DIRECTORY, dir_fd=parent)
                custody.callback(os.close, recovered)
                if stat.S_IMODE(_owned_directory(recovered).st_mode) != 0o700:
                    _refuse("recovery custody permissions conflict")
                os.fsync(parent)
                parents[relative] = (parent, recovered, _identity(os.fstat(recovered))[:2])
            vacated = set()
            for key in changed:
                relative, name, _, mode = _PAYLOADS[key]
                parent, recovered, recovered_identity = parents[relative]
                _prerequisite(manager)
                _remaining(root_fd, request, original, vacated)
                with _parent(root_fd, relative) as current_parent:
                    current = os.stat(recovery_name, dir_fd=current_parent, follow_symlinks=False)
                    if not stat.S_ISDIR(current.st_mode) or _identity(current)[:2] != recovered_identity:
                        _refuse("recovery custody changed")
                # An exclusive hard link preserves bytes and metadata on this
                # filesystem before live-name removal, even across interruption.
                os.link(name, name, src_dir_fd=parent, dst_dir_fd=recovered, follow_symlinks=False)
                with _payload(recovered, name, request["old"][key], mode) as (fd, identity):
                    if identity != original[key]:
                        _refuse("retained payload changed")
                    os.fsync(fd)
                os.fsync(recovered)
                os.fsync(parent)
                _prerequisite(manager)
                _remaining(root_fd, request, original, vacated)
                with _parent(root_fd, relative) as current_parent:
                    current = os.stat(recovery_name, dir_fd=current_parent, follow_symlinks=False)
                    if not stat.S_ISDIR(current.st_mode) or _identity(current)[:2] != recovered_identity:
                        _refuse("recovery custody changed")
                with _payload(recovered, name, request["old"][key], mode) as (_, identity):
                    if identity != original[key]:
                        _refuse("retained payload changed")
                os.unlink(name, dir_fd=parent)
                vacated.add(key)
                os.fsync(parent)
            _prerequisite(manager)
            return {"retained": changed, "unchanged": [key for key in _PAYLOADS if key not in vacated]}
    except ReplacementRefusal:
        raise
    except Exception:
        _refuse("payload custody unavailable")
