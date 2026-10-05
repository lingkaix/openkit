#!/bin/sh
set -eu

# Installs the three verified NanoHost distribution payloads without managing service lifecycle.

cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
umask 077

NANOHOST_SOURCE=nanohost
GATEWAY_SOURCE=openshell-gateway
UNIT_SOURCE=openkit-nanohost.service
NANOHOST_DEST=/usr/lib/openkit/nanohost
GATEWAY_DEST=/usr/lib/openkit/openshell-gateway
UNIT_DEST=/etc/systemd/system/openkit-nanohost.service
NANOHOST_TEMP=/usr/lib/openkit/.nanohost.openkit-install
GATEWAY_TEMP=/usr/lib/openkit/.openshell-gateway.openkit-install
UNIT_TEMP=/etc/systemd/system/.openkit-nanohost.service.openkit-install

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

is_regular_nonlink() {
  [ -f "$1" ] && [ ! -L "$1" ]
}

check_real_ancestors() {
  path=$(dirname -- "$1")
  while [ "$path" != / ]; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      [ -d "$path" ] && [ ! -L "$path" ] || return 1
    fi
    path=$(dirname -- "$path")
  done
  [ -d / ] && [ ! -L / ]
}

file_state() {
  path=$1
  source=$2
  mode=$3
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    printf absent
  elif is_regular_nonlink "$path" && cmp -s -- "$source" "$path" && [ "$(stat -c '%a' -- "$path")" = "$mode" ]; then
    printf exact
  else
    printf conflict
  fi
}

file_identity() {
  stat -c '%d:%i' -- "$1"
}

claim_temporary() {
  path=$1
  (set -C; : >"$path") 2>/dev/null || return 1
  file_identity "$path"
}

cleanup_created_temporary() {
  path=$1
  identity=$2
  [ -n "$identity" ] || return 0
  is_regular_nonlink "$path" || return 0
  current=$(file_identity "$path" 2>/dev/null) || return 0
  [ "$current" = "$identity" ] || return 0
  rm -f -- "$path"
}

# The fixed Python prerequisite is only an inspection tool, never a service dependency.
# GNU timeout bounds interpreter startup and result collection; no package is provisioned here.
host_check() {
  # Bound the collector too: a surviving interpreter holds only its inner capture pipe.
  # Keep the original quoted heredoc outside command substitution; no capture file is created.
  host_check_collect() {
    # Whole-invocation ceiling includes startup and the current profile's 230s probe budget.
    /usr/bin/timeout -s KILL 240 /bin/sh -c '
if host_output=$(/usr/bin/python3 -I -B - "$@" 2>/dev/null); then
  host_status=0
else
  host_status=$?
fi
printf "%s\n" "$host_status:$host_output"
' host-check "$@" <<'HOST_CHECK_PY'
# Repository-owned static probes; no provisioning or runtime construction occurs here.
import datetime
import hashlib
import ipaddress
import json
import math
import os
import re
import select
import signal
import stat
import struct
import subprocess
import sys
import tarfile
import time
from pathlib import Path

CLASSES = {'platform', 'service-manager', 'kernel', 'executable', 'version', 'libc', 'filesystem'}
PROBES = {'platform', 'systemd', 'cgroup-v2', 'namespaces', 'seccomp', 'service-principal', 'executable', 'docker-version', 'git-version', 'resolver', 'libc', 'ancestors'}
MAX_OUTPUT = 16384

if sys.version_info < (3, 8):
    sys.exit(1)


def compact(value):
    """Serializes the exact ordered observation bytes used by the evidence digest."""
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False)


def sha(data):
    """Hashes exact bytes without normalizing their representation."""
    return hashlib.sha256(data).hexdigest()


def read_regular(path, limit=MAX_OUTPUT):
    """Reads a bounded regular file without following a final symlink."""
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('nonregular inspection input')
        data = b''
        while len(data) <= limit:
            block = os.read(fd, limit + 1 - len(data))
            if not block:
                break
            data += block
        if len(data) > limit:
            raise ValueError('inspection input exceeds bound')
        return data
    finally:
        os.close(fd)


def bounded(action, seconds):
    """Bounds filesystem and executable observations together in one killed process group."""
    try:
        read_fd, write_fd = os.pipe()
    except OSError:
        return {'error': 'unobservable'}
    try:
        child = os.fork()
    except OSError:
        os.close(read_fd)
        os.close(write_fd)
        return {'error': 'unobservable'}
    if child == 0:
        os.close(read_fd)
        os.setsid()
        # A killed but unreaped probe must not hold the shell's result-capture pipe open.
        os.close(1)
        os.close(2)
        try:
            value = action()
            payload = compact({'ok': value}).encode()
            if len(payload) > MAX_OUTPUT:
                raise ValueError('observation exceeds bound')
        except FileNotFoundError:
            payload = b'{"error":"absent"}'
        except Exception:
            payload = b'{"error":"unobservable"}'
        os.write(write_fd, payload)
        os.close(write_fd)
        os._exit(0)
    os.close(write_fd)
    data = b''
    deadline = time.monotonic() + seconds
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([read_fd], [], [], remaining)[0]:
                return {'error': 'timeout'}
            block = os.read(read_fd, MAX_OUTPUT + 1)
            if not block:
                return json.loads(data) if data else {'error': 'unobservable'}
            data += block
            if len(data) > MAX_OUTPUT:
                return {'error': 'unobservable'}
    finally:
        os.close(read_fd)
        try:
            os.killpg(child, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            # A child that finished before setsid still belongs to the parent's group.
            try:
                os.kill(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
        # SIGKILL cannot finish uninterruptible I/O; never wait beyond the probe deadline.
        # An unfinished child is reclaimed by the OS after this short-lived checker exits.
        os.waitpid(child, os.WNOHANG)


def command_result(args):
    """Bounds both output channels; the enclosing process group owns timeout cleanup."""
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'SYSTEMD_LOG_LEVEL': 'warning'})
    channels = [process.stdout, process.stderr]
    data = {channel: b'' for channel in channels}
    while channels:
        ready, _, _ = select.select(channels, [], [])
        for channel in ready:
            block = os.read(channel.fileno(), MAX_OUTPUT + 1)
            if not block:
                channels.remove(channel)
                continue
            data[channel] += block
            if sum(map(len, data.values())) > MAX_OUTPUT:
                process.kill()
                process.wait()
                raise ValueError('inspector output exceeds bound')
    return process.wait(), data[process.stdout].decode().strip(), data[process.stderr].decode().strip()


def command(args):
    """Requires an inspection command to complete successfully with bounded UTF-8 output."""
    status, output, _ = command_result(args)
    if status != 0:
        raise ValueError('inspector failed')
    return output


def elf_requirements(path, architecture):
    """Validates target ELF loadability and derives loader and libc symbol-version needs."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        size = os.fstat(fd).st_size
        def read(offset, length):
            if offset < 0 or length < 0 or length > 65536 or offset + length > size:
                raise ValueError('ELF range invalid')
            data = os.pread(fd, length, offset)
            if len(data) != length:
                raise ValueError('ELF bytes incomplete')
            return data
        header = read(0, 64)
        kind, machine, version, entry, table = struct.unpack_from('<HHIQQ', header, 16)
        header_size, row_size, count = struct.unpack_from('<HHH', header, 52)
        if header[:7] != b'\x7fELF\x02\x01\x01' or kind not in (2, 3) or machine != {'amd64': 62, 'arm64': 183}[architecture] or version != 1 or header_size != 64 or row_size != 56 or not count or table < 64 or table + count * 56 > size:
            raise ValueError('ELF target or header invalid')
        segments, dynamic, interpreter = [], None, None
        loadable = False
        for index in range(count):
            values = struct.unpack('<IIQQQQQQ', read(table + index * 56, 56))
            kind, flags, offset, address, _, file_size, memory_size, alignment = values
            if offset + file_size > size:
                raise ValueError('ELF segment incomplete')
            if kind == 1:
                segments.append((offset, address, file_size))
                aligned = alignment <= 1 or alignment & (alignment - 1) == 0 and offset % alignment == address % alignment
                loadable |= flags & 1 != 0 and 0 < file_size <= memory_size < 2 ** 32 and offset < 2 ** 32 and alignment < 2 ** 32 and address < 2 ** 63 and address + memory_size <= 2 ** 63 and address <= entry < address + file_size and aligned
            if kind == 2:
                dynamic = (offset, file_size)
            if kind == 3:
                text = read(offset, file_size)
                if not text.endswith(b'\0'):
                    raise ValueError('ELF interpreter invalid')
                interpreter = text[:-1].decode()
                if not interpreter.startswith('/') or '\0' in interpreter:
                    raise ValueError('ELF interpreter invalid')
        if not loadable:
            raise ValueError('ELF has no executable load segment')
        tags = {}
        if dynamic:
            for offset in range(dynamic[0], dynamic[0] + dynamic[1] - 15, 16):
                tag, value = struct.unpack('<QQ', read(offset, 16))
                if tag == 0:
                    break
                tags[tag] = value
        def file_offset(address, length):
            for offset, virtual, file_size in segments:
                if virtual <= address and address + length <= virtual + file_size:
                    return offset + address - virtual
            raise ValueError('ELF dynamic address invalid')
        symbols = set()
        if 0x6ffffffe in tags:
            strings = file_offset(tags[5], tags[10])
            if tags[0x6fffffff] > 1024:
                raise ValueError('ELF needs exceed bound')
            row = file_offset(tags[0x6ffffffe], 16)
            for index in range(tags[0x6fffffff]):
                version, count, _, aux, next_row = struct.unpack('<HHIII', read(row, 16))
                if version != 1 or count > 4096:
                    raise ValueError('ELF version needs invalid')
                auxiliary = row + aux
                for n in range(count):
                    _, _, _, name, next_aux = struct.unpack('<IHHII', read(auxiliary, 16))
                    if name >= tags[10]:
                        raise ValueError('ELF symbol string invalid')
                    text = read(strings + name, min(256, tags[10] - name)).split(b'\0', 1)
                    if len(text) != 2:
                        raise ValueError('ELF symbol name invalid')
                    symbol = text[0].decode()
                    if symbol.startswith('GLIBC_'):
                        symbols.add(symbol)
                    if n + 1 < count and next_aux < 16:
                        raise ValueError('ELF needs chain invalid')
                    auxiliary += next_aux
                if index + 1 < tags[0x6fffffff] and next_row < 16:
                    raise ValueError('ELF needs chain invalid')
                row += next_row
        versions = [name[6:] for name in symbols if re.fullmatch(r'GLIBC_\d+(?:\.\d+)+', name)]
        maximum = max(versions, key=lambda value: tuple(map(int, value.split('.')))) if versions else None
        return {'interpreter': interpreter, 'symbols': sorted(symbols), 'maximumGlibc': maximum}
    finally:
        os.close(fd)


def validate_profile(profile):
    """Admits the closed authority-bearing core while ignoring optional additive fields."""
    if profile.get('schemaVersion') != 2 or not re.fullmatch(r'[a-z][a-z0-9-]{0,127}', profile.get('profileId', '')) or not isinstance(profile.get('architectures'), list) or len(profile['architectures']) != 2 or set(profile['architectures']) != {'amd64', 'arm64'}:
        raise ValueError('host profile invalid')
    ids = set()
    for entry in profile['requirements']:
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,127}', entry.get('id', '')) or entry['id'] in ids or entry.get('class') not in CLASSES or entry.get('probe') not in PROBES or not isinstance(entry.get('predicate'), dict) or type(entry.get('timeoutSeconds')) not in (int, float) or not math.isfinite(entry['timeoutSeconds']) or not entry['timeoutSeconds'] > 0:
            raise ValueError('host requirement invalid')
        ids.add(entry['id'])
        validate_predicate(entry)
    rec = profile['recommendation']
    if not ids or rec.get('scope') != 'combined-small-deployment' or any(type(rec.get(key)) != int or rec[key] <= 0 for key in ('availableLogicalCpus', 'availableMemoryBytes', 'availableStorageBytes')) or type(rec.get('timeoutSeconds')) not in (int, float) or not math.isfinite(rec['timeoutSeconds']) or rec['timeoutSeconds'] <= 0:
        raise ValueError('host recommendation invalid')
    return profile


def validate_predicate(entry):
    """Rejects an unimplemented required predicate instead of silently ignoring its semantics."""
    probe, predicate = entry['probe'], entry['predicate']
    expected = {
        'platform': ('platform', {'os': 'Linux'}),
        'systemd': ('service-manager', {'active': True, 'unit': 'openkit-nanohost.service'}),
        'cgroup-v2': ('kernel', {'filesystem': 'cgroup2fs'}),
        'namespaces': ('kernel', {'names': ['mnt', 'net']}),
        'seccomp': ('kernel', {'supported': True}),
        'service-principal': ('service-manager', {'user': 'root', 'requiredCapabilities': ['CAP_SYS_ADMIN', 'CAP_NET_ADMIN']}),
        'docker-version': ('version', {'path': '/usr/bin/docker', 'minimum': '28.0'}),
        'git-version': ('version', {'path': '/usr/bin/git', 'format': 'git-version'}),
        'resolver': ('filesystem', {'path': '/run/systemd/resolve/resolv.conf', 'usableNameserver': True}),
        'libc': ('libc', {'executables': ['nanohost', 'openshell-gateway'], 'derive': 'elf-version-needs'}),
        'ancestors': ('filesystem', {'paths': ['/usr/lib/openkit/nanohost', '/usr/lib/openkit/openshell-gateway', '/etc/systemd/system/openkit-nanohost.service', '/etc/openkit/nanohost.env', '/var/lib/openkit/nanohost', '/run/openkit/nanohost', '/var/lib/openkit/nanohost-images', '/var/lib/openkit/nanohost-work', '/var/lib/openkit/nanohost-workspace-scan'], 'uid': 0, 'forbidMode': 18}),
    }
    if probe == 'executable':
        if entry['class'] != 'executable' or set(predicate) != {'path', 'regularNonSymlink', 'executable'} or predicate['path'] not in ['/usr/bin/containerd', '/usr/bin/dockerd', '/usr/bin/docker', '/usr/bin/git', '/usr/bin/slirp4netns'] or predicate['regularNonSymlink'] is not True or predicate['executable'] is not True:
            raise ValueError('executable predicate invalid')
    elif (entry['class'], predicate) != expected[probe]:
        raise ValueError('required predicate unsupported')


def load_bundle(root):
    """Uses only checksum-verified bundle bytes and validates profile/provenance binding."""
    for directory in (root, root / 'licenses'):
        if not stat.S_ISDIR(directory.lstat().st_mode):
            raise ValueError('bundle directory nonregular')
    sums = read_regular(root / 'SHA256SUMS').decode()
    expected_files = ['MANIFEST.json', 'host-manifest.json', 'install.sh', 'licenses/openkit-LICENSE', 'licenses/openshell-LICENSE', 'licenses/openshell-THIRD-PARTY-NOTICES', 'nanohost', 'openkit-nanohost.service', 'openshell-gateway']
    rows = [re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9./-]+)', line) for line in sums.splitlines()]
    if len(rows) != len(expected_files) or any(not row for row in rows) or [row[2] for row in rows] != expected_files:
        raise ValueError('bundle checksums invalid')
    for row in rows:
        fd = os.open(root / row[2], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError('bundle member nonregular')
            digest = hashlib.sha256()
            while block := os.read(fd, 65536):
                digest.update(block)
            if digest.hexdigest() != row[1]:
                raise ValueError('bundle checksum mismatch')
        finally:
            os.close(fd)
    profile_bytes = read_regular(root / 'host-manifest.json', 65536)
    profile = validate_profile(json.loads(profile_bytes))
    release = json.loads(read_regular(root / 'MANIFEST.json', 65536))
    if release.get('schemaVersion') != 2 or release.get('profileId') != profile['profileId'] or release.get('profileDigest') != sha(profile_bytes) or release.get('architecture') not in profile['architectures'] or release.get('target') != 'linux/' + release['architecture'] or not re.fullmatch(r'[0-9a-f]{40}', release.get('productCommit', '')) or not re.fullmatch(r'v\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?', release.get('tag', '')):
        raise ValueError('bundle profile or provenance mismatch')
    if release.get('files') != ['MANIFEST.json', 'SHA256SUMS', 'host-manifest.json', 'install.sh', 'licenses/openkit-LICENSE', 'licenses/openshell-LICENSE', 'licenses/openshell-THIRD-PARTY-NOTICES', 'nanohost', 'openkit-nanohost.service', 'openshell-gateway']:
        raise ValueError('bundle file projection invalid')
    for name in ('nanohost', 'openshell-gateway'):
        if elf_requirements(root / name, release['architecture']) != release.get('libcRequirements', {}).get(name):
            raise ValueError('bundle executable requirement projection invalid')
    return profile, release


def archive_identity(root, release):
    """Binds extracted bytes to the complete adjacent archive without extracting or writing it."""
    prefix = f"openkit-nanohost-{release['tag']}-linux-{release['architecture']}"
    archive = root.parent / (prefix + '.tar.gz')
    fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('archive nonregular')
        digest = hashlib.sha256()
        while block := stream.read(65536):
            digest.update(block)
        stream.seek(0)
        with tarfile.open(fileobj=stream, mode='r|gz') as archive_stream:
            matched = set()
            for member in archive_stream:
                if member.isdir() and member.name in (prefix, prefix + '/licenses'):
                    continue
                if not member.name.startswith(prefix + '/'):
                    raise ValueError('archive member outside root')
                name = member.name[len(prefix) + 1:]
                if name not in release['files'] or name in matched or not member.isfile():
                    raise ValueError('archive member invalid')
                matched.add(name)
                actual = archive_stream.extractfile(member)
                expected = root / name
                with expected.open('rb') as source:
                    while block := actual.read(65536):
                        if source.read(len(block)) != block:
                            raise ValueError('archive bytes mismatch')
                    if source.read(1):
                        raise ValueError('archive bytes mismatch')
            if matched != set(release['files']):
                raise ValueError('archive file set mismatch')
        return digest.hexdigest()


def unrelated_unit_permission_warning(line, unit):
    """Recognizes only systemd's non-fatal file-mode warnings outside our unit and slice paths."""
    # systemd stat_warn_permissions can warn about other loaded units during read-only verify.
    warning = re.fullmatch(r'Configuration file (/\S+) (?:'
                           r'is marked executable\. Please remove executable permission bits\.|'
                           r'is marked world-writable\. Please remove world writability permission bits\.|'
                           r'is marked world-inaccessible\. This has no effect as configuration data is accessible via APIs without restrictions\.'
                           r') Proceeding anyway\.', line)
    # Include drop-ins in the refusal boundary, regardless of the unit's installation directory.
    return warning is not None and unit not in warning[1] and 'openkit-nanohost.slice' not in warning[1]


def observe(entry, root, release):
    """Collects bounded non-secret capability facts; equality with a qualified host is never required."""
    probe, predicate = entry['probe'], entry['predicate']
    if probe == 'platform':
        return {'os': command(['/usr/bin/uname', '-s']), 'architecture': command(['/usr/bin/uname', '-m'])}
    if probe == 'systemd':
        try:
            systemd_directory = stat.S_ISDIR(Path('/run/systemd/system').lstat().st_mode)
        except FileNotFoundError:
            systemd_directory = False
        active = systemd_directory and read_regular(Path('/proc/1/comm')).strip() == b'systemd'
        # A completed mismatch needs no subordinate inspector; null means not inspected.
        if not active:
            return {'active': False, 'unitParses': None, 'slice': None}
        # verify is read-only; EnvironmentFile is optional only in the parse projection.
        unit = read_regular(root / predicate['unit']).decode()
        status, output, errors = command_result(['/usr/bin/systemd-analyze', 'verify', '--man=no', '--generators=no', str(root / predicate['unit'])])
        expected_absence = predicate['unit'] + ': Command /usr/lib/openkit/nanohost is not executable: No such file or directory'
        errors = '\n'.join(line for line in errors.splitlines() if not unrelated_unit_permission_warning(line, predicate['unit']))
        unexpected = [line for line in errors.splitlines() if line != expected_absence]
        if any('Permission denied' in line or 'Failed to open' in line or 'unrecognized option' in line for line in unexpected):
            raise ValueError('unit inspection unavailable')
        parses = not output and not unexpected and status in (0, 1) and (status == 0 or errors == expected_absence)
        return {'active': active, 'unitParses': parses, 'slice': 'openkit-nanohost.slice' if 'Slice=openkit-nanohost.slice' in unit else None}
    if probe == 'service-principal':
        unit = read_regular(root / 'openkit-nanohost.service').decode()
        user = re.findall(r'^User=(.*)$', unit, re.M)
        bounding = re.findall(r'^CapabilityBoundingSet=(.*)$', unit, re.M)
        return {'user': user[-1] if user else 'root', 'capabilities': bounding[-1].split() if bounding else predicate['requiredCapabilities']}
    if probe == 'cgroup-v2':
        if not Path('/sys/fs/cgroup').exists():
            return {'filesystem': None}
        return {'filesystem': command(['/usr/bin/stat', '-fc', '%T', '/sys/fs/cgroup'])}
    if probe == 'namespaces':
        names = []
        for name in predicate['names']:
            try:
                os.stat('/proc/self/ns/' + name)
                names.append(name)
            except FileNotFoundError:
                pass
        return {'names': names}
    if probe == 'seccomp':
        status = read_regular(Path('/proc/self/status')).decode()
        return {'supported': bool(re.search(r'^Seccomp:\s*[012]\s*$', status, re.M))}
    if probe == 'executable':
        path = Path(predicate['path'])
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            return {'regularNonSymlink': False, 'executable': False}
        return {'regularNonSymlink': stat.S_ISREG(mode), 'executable': os.access(path, os.X_OK)}
    if probe in ('docker-version', 'git-version'):
        executable = observe({'probe': 'executable', 'predicate': {'path': predicate['path']}}, root, release)
        if not all(executable.values()):
            return {'executable': False}
        return {'version': command([predicate['path'], '--version'])}
    if probe == 'resolver':
        path = Path(predicate['path'])
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            return {'regularNonSymlink': False, 'usableNameserver': False}
        if not stat.S_ISREG(mode):
            return {'regularNonSymlink': False, 'usableNameserver': False}
        text = read_regular(path).decode()
        addresses = []
        for line in text.splitlines():
            fields = re.split(r'\s+', re.split(r'[#;]', line)[0].strip())
            if fields[0] == 'nameserver' and len(fields) == 2:
                try:
                    addresses.append(str(ipaddress.ip_address(fields[1])))
                except ValueError:
                    pass
        return {'regularNonSymlink': True, 'usableNameserver': bool(addresses), 'nameservers': addresses[:3]}
    if probe == 'ancestors':
        facts = []
        for destination in predicate['paths']:
            for path in reversed(Path(destination).parents):
                try:
                    meta = path.lstat()
                except FileNotFoundError:
                    continue
                facts.append({'path': str(path), 'directory': stat.S_ISDIR(meta.st_mode), 'uid': meta.st_uid, 'mode': stat.S_IMODE(meta.st_mode)})
                if not stat.S_ISDIR(meta.st_mode):
                    break
        return {'ancestors': facts}
    if probe == 'libc':
        needs = release['libcRequirements']
        required = sorted(set(symbol for name in predicate['executables'] for symbol in needs[name]['symbols']))
        loaders = sorted(set(needs[name]['interpreter'] for name in predicate['executables'] if needs[name]['interpreter']))
        for name in predicate['executables']:
            interpreter = needs[name]['interpreter']
            if not interpreter:
                continue
            try:
                loader_mode = os.stat(interpreter).st_mode
            except FileNotFoundError:
                return {'requiredSymbols': required, 'loaders': loaders, 'compatible': False}
            if not stat.S_ISREG(loader_mode):
                return {'requiredSymbols': required, 'loaders': loaders, 'compatible': False}
            for flag in ('--verify', '--list'):
                status, _, errors = command_result([interpreter, flag, str(root / name)])
                if status != 0:
                    if re.search(r"version [`']GLIBC_[^ ]+' not found|cannot open shared object file", errors):
                        return {'requiredSymbols': required, 'loaders': loaders, 'compatible': False}
                    raise ValueError('loader observation failed')
        return {'requiredSymbols': required, 'loaders': loaders, 'compatible': True}
    raise ValueError('unknown probe')


def compare_requirement(entry, facts, release):
    """Applies the profile's closed predicates to fixture and live normalized facts alike."""
    probe, predicate = entry['probe'], entry['predicate']
    boolean_fields = {
        'seccomp': ('supported',),
        'executable': ('regularNonSymlink', 'executable'),
        'resolver': ('regularNonSymlink', 'usableNameserver'), 'libc': ('compatible',),
    }
    if not isinstance(facts, dict) or any(type(facts[key]) != bool for key in boolean_fields.get(probe, ())):
        raise ValueError('malformed observation')
    if probe == 'ancestors':
        if not isinstance(facts['ancestors'], list) or not facts['ancestors']:
            raise ValueError('ancestor observation incomplete')
        for item in facts['ancestors']:
            if type(item['directory']) != bool or type(item['uid']) != int or item['uid'] < 0 or type(item['mode']) != int or not 0 <= item['mode'] <= 4095 or not isinstance(item['path'], str) or not item['path'].startswith('/'):
                raise ValueError('ancestor observation malformed')
    if probe == 'platform':
        architecture = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(facts['architecture'])
        met = facts['os'] == predicate['os'] and architecture == release['architecture']
    elif probe == 'systemd':
        if type(facts['active']) != bool:
            raise ValueError('malformed systemd observation')
        if facts['active'] is False:
            return 'unmet'
        if type(facts['unitParses']) != bool:
            raise ValueError('incomplete unit observation')
        met = facts['unitParses'] is True and facts['slice'] == 'openkit-nanohost.slice'
    elif probe == 'service-principal':
        met = facts['user'] == predicate['user'] and set(predicate['requiredCapabilities']) <= set(facts['capabilities'])
    elif probe == 'cgroup-v2':
        met = facts['filesystem'] == predicate['filesystem']
    elif probe == 'namespaces':
        met = set(predicate['names']) <= set(facts['names'])
    elif probe == 'seccomp':
        met = facts['supported'] is True
    elif probe == 'executable':
        met = facts['regularNonSymlink'] is True and facts['executable'] is True
    elif probe in ('docker-version', 'git-version'):
        if facts.get('executable') is False:
            return 'unmet'
        pattern = r'Docker version (\d+)\.(\d+)(?:\.\d+)?(?:, build [A-Za-z0-9.-]+)?' if probe == 'docker-version' else r'git version (\d+)\.(\d+)(?:\.\d+)+(?:[ .][A-Za-z0-9()._-]+)*'
        version = re.fullmatch(pattern, facts['version'])
        if not version:
            return 'cannot-check'
        met = probe == 'git-version' or tuple(map(int, version.groups()[:2])) >= tuple(map(int, predicate['minimum'].split('.')))
    elif probe == 'resolver':
        met = facts['regularNonSymlink'] is True and facts['usableNameserver'] is True
    elif probe == 'libc':
        met = facts['compatible'] is True
    elif probe == 'ancestors':
        met = all(item['directory'] is True and item['uid'] == predicate['uid'] and item['mode'] & predicate['forbidMode'] == 0 for item in facts['ancestors'])
    else:
        raise ValueError('unknown comparator')
    return 'met' if met else 'unmet'


def resources(root):
    """Observes available capacity; unknown capacity never becomes zero or total capacity."""
    cpus = len(os.sched_getaffinity(0))
    memory = read_regular(Path('/proc/meminfo')).decode()
    match = re.search(r'^MemAvailable:\s*(\d+) kB$', memory, re.M)
    if not match:
        raise ValueError('available memory unknown')
    path = Path('/var/lib/openkit')
    while not path.exists():
        path = path.parent
    storage = os.statvfs(path)
    return {'availableLogicalCpus': cpus, 'availableMemoryBytes': int(match[1]) * 1024, 'availableStorageBytes': storage.f_bavail * storage.f_frsize}


def machine_identity():
    """Hashes the exact nonempty platform installation identifier, exposing no raw value."""
    data = read_regular(Path('/etc/machine-id'), 4096)
    if not data:
        raise ValueError('machine identity unavailable')
    return sha(data)


def check(root, observer=observe, resource_observer=resources):
    """Returns one terminal requirement object; a mismatch wins over incomplete observations."""
    result = dict(schemaVersion=2, profileId=None, profileDigest=None, productCommit=None, archiveSha256=None, machineIdentityDigest=None, machineObservationDigest=sha(b'[]'), checkedAt=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'), hardVerdict='cannot-check', recommendationObservation='cannot-check', requirements=[])
    loaded = bounded(lambda: load_bundle(root), 30)
    if 'ok' not in loaded:
        return result
    profile, release = loaded['ok']
    result.update(profileId=profile['profileId'], profileDigest=release['profileDigest'], productCommit=release['productCommit'])
    archive = bounded(lambda: archive_identity(root, release), 30)
    identity = bounded(machine_identity, 5)
    result['archiveSha256'] = archive.get('ok')
    result['machineIdentityDigest'] = identity.get('ok')
    incomplete = 'ok' not in archive or 'ok' not in identity
    mismatch = False
    for entry in profile['requirements']:
        observation = bounded(lambda: observer(entry, root, release), entry['timeoutSeconds'])
        facts = observation.get('ok')
        try:
            outcome = compare_requirement(entry, facts, release) if facts is not None else 'cannot-check'
        except (KeyError, TypeError, ValueError):
            outcome = 'cannot-check'
        if outcome == 'cannot-check':
            facts = None
        result['requirements'].append(dict(id=entry['id'], outcome=outcome, observed=facts))
        mismatch |= outcome == 'unmet'
        incomplete |= outcome == 'cannot-check'
    result['hardVerdict'] = 'requirements-unmet' if mismatch else 'cannot-check' if incomplete else 'requirements-met'
    result['machineObservationDigest'] = sha(compact(result['requirements']).encode())
    observation = bounded(lambda: resource_observer(root), profile['recommendation']['timeoutSeconds'])
    if 'ok' in observation:
        try:
            result['recommendationObservation'] = 'met' if all(observation['ok'][key] >= profile['recommendation'][key] for key in ('availableLogicalCpus', 'availableMemoryBytes', 'availableStorageBytes')) else 'unmet'
        except (KeyError, TypeError):
            pass
    return result

# HOST_CHECK_MAIN
if __name__ == '__main__':
    root = Path.cwd()
    if sys.argv[1:] == ['--verify-profile']:
        loaded = bounded(lambda: load_bundle(root), 30)
        if 'ok' in loaded:
            print('HOST_CHECK_VERIFIED')
            sys.exit(0)
        sys.exit(1)
    result = check(root)
    print('HOST_CHECK_RESULT:' + compact(result))
    sys.exit(0 if result['hardVerdict'] == 'requirements-met' else 1)
HOST_CHECK_PY
  }
  if host_output=$(host_check_collect "$@" 2>/dev/null); then
    host_status=${host_output%%:*}
    host_output=${host_output#*:}
  else
    host_status=$?
  fi
  if [ "${1-}" = --verify-profile ]; then
    [ "$host_status" = 0 ] && [ "$host_output" = HOST_CHECK_VERIFIED ]
    return $?
  fi
  # Accept only a completed internal frame, never startup diagnostics or partial output.
  case "$host_status:$host_output" in
    0:HOST_CHECK_RESULT:*|1:HOST_CHECK_RESULT:*)
      host_output=${host_output#HOST_CHECK_RESULT:}
      case "$host_output" in
        *'
'*|'') host_output= ;;
        '{"schemaVersion":2,'*'}') ;;
        *) host_output= ;;
      esac ;;
    *) host_output= ;;
  esac
  if [ -z "$host_output" ]; then
    host_status=1
    host_output='{"schemaVersion":2,"profileId":null,"profileDigest":null,"productCommit":null,"archiveSha256":null,"machineIdentityDigest":null,"machineObservationDigest":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945","checkedAt":null,"hardVerdict":"cannot-check","recommendationObservation":"cannot-check","requirements":[]}'
  fi
  if [ "${1-}" = --installation-check ]; then
    case "$host_output" in
      *'"profileId":null,'*) printf '%s\n' 'host-profile=invalid' >&2 ;;
      *)
        printf '%s\n' 'package=pass'
        if [ "$host_status" -ne 0 ]; then
          case "$host_output" in
            *'"hardVerdict":"requirements-unmet",'*) printf '%s\n' 'host-prerequisites=requirements-unmet' >&2 ;;
            *) printf '%s\n' 'host-prerequisites=cannot-check' >&2 ;;
          esac
        fi ;;
    esac
  else
    printf '%s\n' "$host_output"
  fi
  return "$host_status"
}

case "${1-}" in
  --check-host) [ "$#" -eq 1 ] || fail 'arguments=invalid'; host_check; exit $? ;;
  ''|--check) ;;
  *) fail 'arguments=invalid' ;;
esac

if [ -n "${DESTDIR-}" ]; then
  host_check --verify-profile || fail 'host-profile=invalid'
  printf '%s\n' 'package=pass'
else
  # Verification and static observations share one invocation and one bundle load.
  host_check --installation-check || exit 1
fi

case "${1-}" in
  '') ;;
  --check) [ "$#" -eq 1 ] || fail 'arguments=invalid' ;;
  *) fail 'arguments=invalid' ;;
esac

if [ -n "${DESTDIR-}" ]; then
  [ "$#" -eq 0 ] || fail 'arguments=invalid'
  case "$DESTDIR" in /*) ;; *) fail 'destdir=invalid' ;; esac
  [ "$DESTDIR" != / ] || fail 'destdir=invalid'
  normalized=$(realpath -m -- "$DESTDIR") || fail 'destdir=invalid'
  [ "$normalized" = "$DESTDIR" ] || fail 'destdir=invalid'
  [ ! -e "$DESTDIR" ] && [ ! -L "$DESTDIR" ] || fail 'destdir=exists'
  check_real_ancestors "$DESTDIR" || fail 'destdir-ancestor=invalid'

  stage_identity=
  stage_complete=false
  cleanup_stage() {
    status=${1:-$?}
    trap - EXIT HUP INT TERM
    current_stage_identity=$(file_identity "$DESTDIR" 2>/dev/null || true)
    if [ -n "$stage_identity" ] && [ "$stage_complete" != true ] && [ "$current_stage_identity" = "$stage_identity" ]; then
      for path in \
        "$DESTDIR/usr/lib/openkit/nanohost" \
        "$DESTDIR/usr/lib/openkit/openshell-gateway" \
        "$DESTDIR/etc/systemd/system/openkit-nanohost.service"; do
        if is_regular_nonlink "$path"; then rm -f -- "$path"; fi
      done
      rmdir -- "$DESTDIR/usr/lib/openkit" "$DESTDIR/usr/lib" "$DESTDIR/usr" 2>/dev/null || true
      rmdir -- "$DESTDIR/etc/systemd/system" "$DESTDIR/etc/systemd" "$DESTDIR/etc" 2>/dev/null || true
      rmdir -- "$DESTDIR" 2>/dev/null || true
    fi
    exit "$status"
  }
  trap 'cleanup_stage $?' EXIT
  trap 'cleanup_stage 129' HUP
  trap 'cleanup_stage 130' INT
  trap 'cleanup_stage 143' TERM
  stage_identity=$(mkdir -m 0700 -- "$DESTDIR" && file_identity "$DESTDIR") || fail 'destdir=create-failed'
  mkdir -m 0755 -p -- "$DESTDIR/usr/lib/openkit" "$DESTDIR/etc/systemd/system"
  install -m 0755 -- "$NANOHOST_SOURCE" "$DESTDIR$NANOHOST_DEST"
  install -m 0755 -- "$GATEWAY_SOURCE" "$DESTDIR$GATEWAY_DEST"
  install -m 0644 -- "$UNIT_SOURCE" "$DESTDIR$UNIT_DEST"
  stage_complete=true
  trap - EXIT HUP INT TERM
  printf '%s\n' 'staged-only'
  exit 0
fi

[ -d /etc/systemd/system ] && [ ! -L /etc/systemd/system ] || fail 'destination-ancestor=invalid:/etc/systemd/system'
exec 9</etc/systemd/system || fail 'installer-lock=unavailable'
flock -x 9 || fail 'installer-lock=unavailable'
for path in "$NANOHOST_DEST" "$GATEWAY_DEST" "$UNIT_DEST" "$NANOHOST_TEMP" "$GATEWAY_TEMP" "$UNIT_TEMP"; do
  check_real_ancestors "$path" || fail "destination-ancestor=invalid:$path"
done
printf '%s\n' 'host-prerequisites=pass'

nanohost_dest_state=$(file_state "$NANOHOST_DEST" "$NANOHOST_SOURCE" 755)
gateway_dest_state=$(file_state "$GATEWAY_DEST" "$GATEWAY_SOURCE" 755)
unit_dest_state=$(file_state "$UNIT_DEST" "$UNIT_SOURCE" 644)
nanohost_temp_state=$(file_state "$NANOHOST_TEMP" "$NANOHOST_SOURCE" 755)
gateway_temp_state=$(file_state "$GATEWAY_TEMP" "$GATEWAY_SOURCE" 755)
unit_temp_state=$(file_state "$UNIT_TEMP" "$UNIT_SOURCE" 644)

if [ "$nanohost_dest_state$gateway_dest_state$unit_dest_state$nanohost_temp_state$gateway_temp_state$unit_temp_state" = absentabsentabsentabsentabsentabsent ]; then
  disposition=installable
elif [ "$nanohost_dest_state$gateway_dest_state$unit_dest_state$nanohost_temp_state$gateway_temp_state$unit_temp_state" = exactexactexactabsentabsentabsent ]; then
  disposition=already-installed
elif [ "$nanohost_dest_state" != conflict ] && [ "$gateway_dest_state" != conflict ] && [ "$unit_dest_state" != conflict ] && [ "$nanohost_temp_state" != conflict ] && [ "$gateway_temp_state" != conflict ] && [ "$unit_temp_state" != conflict ]; then
  disposition=resumable
else
  disposition=destination-conflict
fi
printf 'destination=%s\n' "$disposition"
[ "$disposition" != destination-conflict ] || exit 1
[ "${1-}" != --check ] || exit 0
[ "$disposition" != already-installed ] || {
  printf '%s\n' 'installation=already-installed'
  printf '%s\n' 'remaining=configuration,enrollment,service-start'
  exit 0
}

created_nanohost_identity=
created_gateway_identity=
created_unit_identity=
created_openkit_identity=
install_complete=false
cleanup_live() {
  status=${1:-$?}
  trap - EXIT HUP INT TERM
  if [ "$install_complete" != true ]; then
    cleanup_created_temporary "$NANOHOST_TEMP" "$created_nanohost_identity"
    cleanup_created_temporary "$GATEWAY_TEMP" "$created_gateway_identity"
    cleanup_created_temporary "$UNIT_TEMP" "$created_unit_identity"
    current_openkit_identity=$(file_identity /usr/lib/openkit 2>/dev/null || true)
    if [ -n "$created_openkit_identity" ] && [ "$current_openkit_identity" = "$created_openkit_identity" ]; then
      rmdir -- /usr/lib/openkit 2>/dev/null || true
    fi
    printf '%s\n' 'installation=incomplete' >&2
  fi
  exit "$status"
}
trap 'cleanup_live $?' EXIT
trap 'cleanup_live 129' HUP
trap 'cleanup_live 130' INT
trap 'cleanup_live 143' TERM

if [ ! -d /usr/lib/openkit ]; then
  created_openkit_identity=$(mkdir -m 0755 -- /usr/lib/openkit && file_identity /usr/lib/openkit) || fail 'destination-ancestor=invalid:/usr/lib/openkit'
fi
if [ "$nanohost_dest_state" = absent ] && [ "$nanohost_temp_state" = absent ]; then
  created_nanohost_identity=$(claim_temporary "$NANOHOST_TEMP") || fail 'destination-conflict'
  install -m 0755 -- "$NANOHOST_SOURCE" "$NANOHOST_TEMP"
fi
if [ "$gateway_dest_state" = absent ] && [ "$gateway_temp_state" = absent ]; then
  created_gateway_identity=$(claim_temporary "$GATEWAY_TEMP") || fail 'destination-conflict'
  install -m 0755 -- "$GATEWAY_SOURCE" "$GATEWAY_TEMP"
fi
if [ "$unit_dest_state" = absent ] && [ "$unit_temp_state" = absent ]; then
  created_unit_identity=$(claim_temporary "$UNIT_TEMP") || fail 'destination-conflict'
  install -m 0644 -- "$UNIT_SOURCE" "$UNIT_TEMP"
fi

if [ "$nanohost_dest_state" = absent ]; then
  ln -- "$NANOHOST_TEMP" "$NANOHOST_DEST" || fail 'installation=incomplete'
  [ "$(file_state "$NANOHOST_DEST" "$NANOHOST_SOURCE" 755)" = exact ] || fail 'installation=incomplete'
fi
if [ "$gateway_dest_state" = absent ]; then
  ln -- "$GATEWAY_TEMP" "$GATEWAY_DEST" || fail 'installation=incomplete'
  [ "$(file_state "$GATEWAY_DEST" "$GATEWAY_SOURCE" 755)" = exact ] || fail 'installation=incomplete'
fi
if [ "$unit_dest_state" = absent ]; then
  ln -- "$UNIT_TEMP" "$UNIT_DEST" || fail 'installation=incomplete'
  [ "$(file_state "$UNIT_DEST" "$UNIT_SOURCE" 644)" = exact ] || fail 'installation=incomplete'
fi
if [ "$(file_state "$NANOHOST_TEMP" "$NANOHOST_SOURCE" 755)" = exact ]; then rm -f -- "$NANOHOST_TEMP"; fi
if [ "$(file_state "$GATEWAY_TEMP" "$GATEWAY_SOURCE" 755)" = exact ]; then rm -f -- "$GATEWAY_TEMP"; fi
if [ "$(file_state "$UNIT_TEMP" "$UNIT_SOURCE" 644)" = exact ]; then rm -f -- "$UNIT_TEMP"; fi
install_complete=true
trap - EXIT HUP INT TERM
printf '%s\n' 'installation=complete'
printf '%s\n' 'remaining=configuration,enrollment,service-start'
