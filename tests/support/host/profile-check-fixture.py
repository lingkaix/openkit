# Executes the installer's real comparator and integrity path over a contained fixture root.
import tempfile
from unittest.mock import patch

profile = json.loads(Path('apps/nanohost/deploy/host-manifest.json').read_bytes())
facts = {
    'platform': {'os': 'Linux', 'architecture': 'aarch64'},
    'systemd': {'active': True, 'unitParses': True, 'slice': 'openkit-nanohost.slice'},
    'service-principal': {'user': 'root', 'capabilities': ['CAP_SYS_ADMIN', 'CAP_NET_ADMIN']},
    'cgroup-v2': {'filesystem': 'cgroup2fs'},
    'namespaces': {'names': ['mnt', 'net']},
    'seccomp': {'supported': True},
    'executable': {'regularNonSymlink': True, 'executable': True},
    'docker-version': {'version': 'Docker version 28.0.4, build abcdef1'},
    'git-version': {'version': 'git version 2.55.0'},
    'resolver': {'regularNonSymlink': True, 'usableNameserver': True, 'nameservers': ['1.1.1.1']},
    'libc': {'requiredSymbols': [], 'loaders': [], 'compatible': True},
    'ancestors': {'ancestors': [{'path': '/', 'directory': True, 'uid': 0, 'mode': 493}]},
}
negative = {
    'platform': {'os': 'Darwin', 'architecture': 'aarch64'},
    'systemd': {'active': False, 'unitParses': True, 'slice': 'openkit-nanohost.slice'},
    'service-principal': {'user': 'nobody', 'capabilities': []},
    'cgroup-v2': {'filesystem': 'tmpfs'},
    'namespaces': {'names': ['mnt']},
    'seccomp': {'supported': False},
    'executable': {'regularNonSymlink': False, 'executable': False},
    'docker-version': {'version': 'Docker version 27.9.9, build abcdef1'},
    'git-version': {'executable': False},
    'resolver': {'regularNonSymlink': True, 'usableNameserver': False},
    'libc': {'requiredSymbols': ['GLIBC_2.38'], 'loaders': [], 'compatible': False},
    'ancestors': {'ancestors': [{'path': '/', 'directory': False, 'uid': 0, 'mode': 493}]},
}
capacity = {'availableLogicalCpus': 4, 'availableMemoryBytes': 16 * 1024 ** 3, 'availableStorageBytes': 60 * 1024 ** 3}
original_read = read_regular


def fixture_read(path, limit=MAX_OUTPUT):
    """Keeps machine identity attempt-local while retaining real bounded file reads."""
    if str(path) == '/etc/machine-id':
        return original_read(root / 'fixture-machine-id', limit)
    return original_read(path, limit)


def snapshot(root):
    """Detects path, content, mode, and link mutations inside the contained fixture."""
    return [(str(path.relative_to(root)), path.lstat().st_mode, path.read_bytes() if path.is_file() else b'') for path in sorted(root.rglob('*'))]


def refresh(root):
    """Regenerates independent bundle checksums and its adjacent source archive."""
    root.joinpath('SHA256SUMS').write_text(''.join(sha(root.joinpath(name).read_bytes()) + '  ' + name + '\n' for name in release['files'] if name != 'SHA256SUMS'))
    with tarfile.open(root.parent / (prefix + '.tar.gz'), 'w:gz') as archive:
        for name in release['files']:
            archive.add(root / name, arcname=prefix + '/' + name)


with tempfile.TemporaryDirectory(prefix='openkit-profile-check-') as temporary:
    prefix = 'openkit-nanohost-v0.1.0-rc.1-linux-arm64'
    root = Path(temporary) / prefix
    root.mkdir()
    files = ['MANIFEST.json', 'SHA256SUMS', 'host-manifest.json', 'install.sh', 'licenses/openkit-LICENSE', 'licenses/openshell-LICENSE', 'licenses/openshell-THIRD-PARTY-NOTICES', 'nanohost', 'openkit-nanohost.service', 'openshell-gateway']
    data = bytearray(132)
    data[:7] = b'\x7fELF\x02\x01\x01'
    struct.pack_into('<HHIQQ', data, 16, 2, 183, 1, 0x400078, 64)
    struct.pack_into('<HHH', data, 52, 64, 56, 1)
    struct.pack_into('<IIQQQQQQ', data, 64, 1, 5, 0, 0x400000, 0x400000, 132, 132, 4096)
    for name in files:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data if name in ('nanohost', 'openshell-gateway') else b'fixture\n')
    root.joinpath('fixture-machine-id').write_bytes(b'0123456789abcdef0123456789abcdef\n')
    profile_bytes = json.dumps(profile, indent=2).encode() + b'\n'
    root.joinpath('host-manifest.json').write_bytes(profile_bytes)
    release = {'schemaVersion': 2, 'profileId': profile['profileId'], 'profileDigest': sha(profile_bytes), 'productCommit': 'a' * 40, 'architecture': 'arm64', 'target': 'linux/arm64', 'tag': 'v0.1.0-rc.1', 'files': files, 'libcRequirements': {name: {'interpreter': None, 'symbols': [], 'maximumGlibc': None} for name in ('nanohost', 'openshell-gateway')}}
    root.joinpath('MANIFEST.json').write_text(compact(release))
    refresh(root)
    with patch('__main__.read_regular', fixture_read):
        before = snapshot(root)
        result = check(root, lambda entry, *_: facts[entry['probe']], lambda _: capacity)
        assert result['hardVerdict'] == 'requirements-met', result
        assert result['recommendationObservation'] == 'met'
        assert list(result) == ['schemaVersion', 'profileId', 'profileDigest', 'productCommit', 'archiveSha256', 'machineIdentityDigest', 'machineObservationDigest', 'checkedAt', 'hardVerdict', 'recommendationObservation', 'requirements']
        assert result['machineIdentityDigest'] == sha(root.joinpath('fixture-machine-id').read_bytes())
        assert result['machineObservationDigest'] == sha(compact(result['requirements']).encode())
        assert result['archiveSha256'] == sha(root.parent.joinpath(prefix + '.tar.gz').read_bytes())
        assert [item['id'] for item in result['requirements']] == [entry['id'] for entry in profile['requirements']]
        assert all(list(item) == ['id', 'outcome', 'observed'] for item in result['requirements'])
        assert snapshot(root) == before, 'checker wrote into contained root'
        root.joinpath('install.sh').write_bytes(Path('apps/nanohost/deploy/install.sh').read_bytes())
        refresh(root)
        before = snapshot(root)
        shell = subprocess.run(['/bin/sh', str(root / 'install.sh'), '--check-host'], capture_output=True, timeout=30)
        emitted = json.loads(shell.stdout)
        assert shell.stdout == (compact(emitted) + '\n').encode(), shell.stdout
        assert emitted['hardVerdict'] != 'requirements-met', 'the real developer host is not the Linux fixture'
        assert snapshot(root) == before, 'public shell checker wrote into contained root'
        for target in profile['requirements']:
            result = check(root, lambda entry, *_: negative[entry['probe']] if entry['id'] == target['id'] else facts[entry['probe']], lambda _: capacity)
            assert result['hardVerdict'] == 'requirements-unmet', (target, result)
            assert next(item for item in result['requirements'] if item['id'] == target['id'])['outcome'] == 'unmet'
        def unavailable(entry, *_):
            if entry['id'] == 'git-version':
                raise PermissionError('inspection denied')
            return facts[entry['probe']]
        result = check(root, unavailable, lambda _: capacity)
        assert result['hardVerdict'] == 'cannot-check'
        assert next(item for item in result['requirements'] if item['id'] == 'git-version')['observed'] is None
        def mixed(entry, *_):
            if entry['id'] == 'platform':
                return negative['platform']
            return unavailable(entry)
        assert check(root, mixed, lambda _: capacity)['hardVerdict'] == 'requirements-unmet'
        bad_version = lambda entry, *_: {'version': 'malformed'} if entry['probe'] == 'git-version' else facts[entry['probe']]
        assert check(root, bad_version, lambda _: capacity)['hardVerdict'] == 'cannot-check'
        low_capacity = {**capacity, 'availableMemoryBytes': 1}
        result = check(root, lambda entry, *_: facts[entry['probe']], lambda _: low_capacity)
        assert result['hardVerdict'] == 'requirements-met' and result['recommendationObservation'] == 'unmet'
        def unknown_capacity(_):
            raise PermissionError('capacity unavailable')
        result = check(root, lambda entry, *_: facts[entry['probe']], unknown_capacity)
        assert result['hardVerdict'] == 'requirements-met' and result['recommendationObservation'] == 'cannot-check'
        root.joinpath('fixture-machine-id').unlink()
        assert check(root, lambda entry, *_: facts[entry['probe']], lambda _: capacity)['hardVerdict'] == 'cannot-check'
        root.joinpath('fixture-machine-id').write_bytes(b'new machine id\n')
        result = check(root, lambda entry, *_: facts[entry['probe']], lambda _: capacity)
        assert result['machineIdentityDigest'] != sha(b'0123456789abcdef0123456789abcdef\n')
        # Refreshing inner checksums cannot conceal a profile digest mismatch.
        root.joinpath('host-manifest.json').write_bytes(profile_bytes + b' ')
        refresh(root)
        assert check(root)['hardVerdict'] == 'cannot-check'
        root.joinpath('host-manifest.json').unlink()
        assert check(root)['hardVerdict'] == 'cannot-check', 'must not fall back to repository profile'
        root.joinpath('host-manifest.json').write_bytes(profile_bytes)
        refresh(root)
        root.parent.joinpath(prefix + '.tar.gz').unlink()
        assert check(root, lambda entry, *_: facts[entry['probe']], lambda _: capacity)['hardVerdict'] == 'cannot-check'
        refresh(root)
        before = snapshot(root)
        # Real observation seams distinguish regular-file absence, malformed resolver syntax, and symlinks.
        local = root / 'executable'
        local.write_text('#!/bin/sh\nexit 0\n')
        local.chmod(0o755)
        entry = {'probe': 'executable', 'predicate': {'path': str(local)}}
        assert observe(entry, root, release)['executable'] is True
        local.unlink()
        assert observe(entry, root, release)['regularNonSymlink'] is False
        local.symlink_to(root / 'nanohost')
        assert observe(entry, root, release)['regularNonSymlink'] is False
        local.unlink()
        assert snapshot(root) == before
        # The actual compound observer must retain a completed mismatch without an inspector.
        systemd = next(entry for entry in profile['requirements'] if entry['probe'] == 'systemd')
        original_lstat = Path.lstat
        def inactive_systemd(path, *args, **kwargs):
            """Supplies only the definite systemd absence; bundle paths stay real."""
            if str(path) == '/run/systemd/system':
                raise FileNotFoundError('inactive systemd')
            return original_lstat(path, *args, **kwargs)
        for failure in (FileNotFoundError('missing inspector'), PermissionError('denied inspector'), None):
            def unavailable_unit(*_):
                """Makes the subordinate inspector unavailable independently of systemd."""
                if failure is None:
                    time.sleep(1)
                else:
                    raise failure
            with patch.object(Path, 'lstat', inactive_systemd), patch('__main__.command_result', side_effect=unavailable_unit) as inspector:
                direct = observe(systemd, root, release)
                inspector.assert_not_called()
                observation = bounded(lambda: observe(systemd, root, release), 0.05)
                assert observation.get('ok') == direct
                def compound_observer(entry, *args):
                    """Uses the real systemd observer amid independently satisfied requirements."""
                    return observe(entry, *args) if entry['probe'] == 'systemd' else facts[entry['probe']]
                terminal = check(root, compound_observer, lambda _: capacity)
                assert terminal['hardVerdict'] == 'requirements-unmet', terminal
                outcome = next(item for item in terminal['requirements'] if item['id'] == systemd['id'])
                assert outcome['outcome'] == 'unmet' and outcome['observed']['active'] is False
                assert outcome['observed']['unitParses'] is None
                inspector.assert_not_called()
            assert observation.get('ok', {}).get('active') is False, observation
            assert observation['ok']['unitParses'] is None, observation
            assert compare_requirement(systemd, observation['ok'], release) == 'unmet'
        original_waitpid = os.waitpid
        def slow_blocking_reap(pid, flags):
            """Models reap latency only if the subject elects to block."""
            if flags == 0:
                time.sleep(0.25)
            return original_waitpid(pid, flags)
        with patch('os.waitpid', side_effect=slow_blocking_reap):
            started = time.monotonic()
            assert bounded(lambda: time.sleep(1), 0.02)['error'] == 'timeout'
            elapsed = time.monotonic() - started
            assert elapsed < 0.20, ('blocking reap exceeded probe deadline', elapsed)

        assert bounded(lambda: command(['/definitely/missing/inspector']), 1)['error'] == 'absent'
        with patch('os.fork', side_effect=PermissionError('probe process denied')):
            assert bounded(lambda: True, 1)['error'] == 'unobservable'
            assert check(root)['hardVerdict'] == 'cannot-check'
        with patch('os.pipe', side_effect=OSError('probe channel unavailable')):
            assert bounded(lambda: True, 1)['error'] == 'unobservable'
        for entry in profile['requirements']:
            invalid = json.loads(compact(profile))
            next(item for item in invalid['requirements'] if item['id'] == entry['id'])['predicate']['unsupported'] = True
            try:
                validate_profile(invalid)
                raise AssertionError('unknown required semantics admitted')
            except ValueError:
                pass
print('fixture-checks=pass')
