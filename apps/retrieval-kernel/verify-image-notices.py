#!/usr/bin/env python3
"""Compare both built Linux App images' notice bytes with the selected checkout."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid


ROOT = Path(__file__).resolve().parents[2]
NOTICE_DIRECTORY = '/usr/local/share/licenses/retrieval-kernel'
INSPECT_FORMAT = ('{"Id":{{json .Id}},"Os":{{json .Os}},'
                  '"Architecture":{{json .Architecture}}}')


def command(arguments, cwd=None):
    """Bound each external operation and retain failures without printing image configuration."""
    return subprocess.run(arguments, cwd=cwd, check=True, capture_output=True,
                          text=True, timeout=60).stdout


def prepare_expected(destination: Path) -> None:
    """Reuse the source notice collector; never derive expected bytes from the images."""
    source_gaps = ROOT / 'apps/retrieval-kernel/notices/GAPS.json'
    if json.loads(source_gaps.read_bytes()) != []:
        raise ValueError('selected source still has unresolved notice gaps')
    destination.mkdir(parents=True, exist_ok=True)
    command([sys.executable, str(ROOT / 'scripts/retrieval-notices.py'),
             '--output', str(destination / 'crates')], cwd=ROOT / 'apps/retrieval-kernel')
    shutil.copyfile(ROOT / 'apps/retrieval-kernel/vendor/IPADIC-COPYING',
                    destination / 'IPADIC-COPYING')


def regular_files(directory: Path):
    """Admit only regular notice files beneath the extracted or independently generated root."""
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError(f'notice directory is missing or linked: {directory.name}')
    files = {}
    for path in sorted(directory.rglob('*')):
        relative = str(path.relative_to(directory))
        if path.is_symlink():
            raise ValueError(f'linked notice entry: {relative}')
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError(f'nonregular notice entry: {relative}')
        files[relative] = path
    gaps = files.get('crates/GAPS.json')
    if gaps is None or json.loads(gaps.read_bytes()) != []:
        raise ValueError('notice tree must contain an empty crates/GAPS.json')
    return files


def compare_notice_trees(expected: Path, actual: Path) -> int:
    """Reject missing, extra, linked, damaged, or unresolved notice supply."""
    expected_files = regular_files(expected)
    actual_files = regular_files(actual)
    missing = sorted(expected_files.keys() - actual_files.keys())
    extra = sorted(actual_files.keys() - expected_files.keys())
    if missing or extra:
        raise ValueError(f'notice inventory mismatch: missing={missing}, extra={extra}')
    for relative, source in expected_files.items():
        if source.read_bytes() != actual_files[relative].read_bytes():
            raise ValueError(f'notice byte mismatch: {relative}')
    return len(expected_files)


def verify_image(reference: str, platform: str, expected: Path) -> dict:
    """Inspect one pinned image through an owned stopped container, without running its code."""
    identity = json.loads(command(['docker', 'image', 'inspect', '--platform', platform,
                                   '--format', INSPECT_FORMAT, reference]))
    if not isinstance(identity, dict):
        raise ValueError('image inspection did not return an identity object')
    if f"{identity.get('Os')}/{identity.get('Architecture')}" != platform:
        raise ValueError(f'image platform does not match {platform}')
    image_id = identity.get('Id', '')
    if not isinstance(image_id, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
        raise ValueError('image inspection did not return an immutable image ID')
    name = f'openkit-retrieval-notices-{uuid.uuid4().hex}'
    try:
        container_id = command([
            'docker', 'create', '--name', name, '--platform', platform, '--pull=never',
            '--network=none', '--entrypoint', '/bin/true', image_id,
        ]).strip()
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError(f'container creation is unconfirmed; inspect {name} before retrying') from error
    if not re.fullmatch(r'[0-9a-f]{64}', container_id):
        raise ValueError(f'container creation returned no confirmed ID; inspect {name}')
    try:
        with tempfile.TemporaryDirectory(prefix='retrieval-image-notices-extracted-') as temporary:
            actual = Path(temporary)
            command(['docker', 'cp', f'{container_id}:{NOTICE_DIRECTORY}/.', str(actual)])
            files_verified = compare_notice_trees(expected, actual)
    finally:
        # Remove only the container confirmed by this create, including its anonymous volumes.
        # An uncertain creation is not permission to remove an existing object by name.
        try:
            command(['docker', 'rm', '--volumes', container_id])
        except (OSError, subprocess.SubprocessError) as error:
            raise ValueError(f'could not remove verifier container {container_id}') from error
    return {'platform': platform, 'image_id': image_id, 'files_verified': files_verified}


def main(argv=None) -> int:
    """Report complete notice evidence only after both explicit Linux platforms pass."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--amd64-image', required=True, help='already loaded Linux amd64 App image')
    parser.add_argument('--arm64-image', required=True, help='already loaded Linux arm64 App image')
    arguments = parser.parse_args(argv)
    try:
        with tempfile.TemporaryDirectory(prefix='retrieval-image-notices-expected-') as temporary:
            expected = Path(temporary) / 'notices'
            prepare_expected(expected)
            reports = [
                verify_image(arguments.amd64_image, 'linux/amd64', expected),
                verify_image(arguments.arm64_image, 'linux/arm64', expected),
            ]
            inventory = {
                relative: hashlib.sha256(path.read_bytes()).hexdigest()
                for relative, path in regular_files(expected).items()
            }
            tree_hash = hashlib.sha256(json.dumps(
                inventory, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            report = {
                'images': reports,
                'expected_notice_tree_sha256': tree_hash,
                'source_cargo_lock_sha256': hashlib.sha256((ROOT / 'Cargo.lock').read_bytes()).hexdigest(),
            }
        print(json.dumps(report, indent=2))
        return 0
    except subprocess.TimeoutExpired:
        print('Notice verification failed: an external command timed out', file=sys.stderr)
    except subprocess.CalledProcessError as error:
        print(f'Notice verification failed: {error.cmd[0]} exited {error.returncode}', file=sys.stderr)
    except (OSError, ValueError) as error:
        print(f'Notice verification failed: {error}', file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
