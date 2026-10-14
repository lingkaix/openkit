#!/usr/bin/env python3
"""Package dependency metadata and the license/notice files supplied by locked crates."""
import argparse
import json
import hashlib
from pathlib import Path
import shutil
import subprocess


def collect(output: Path) -> None:
    """Copy supplied notices without rewriting their copyright or license text."""
    metadata = json.loads(subprocess.check_output([
        'cargo', 'metadata', '--locked', '--offline', '--format-version', '1'
    ]))
    output.mkdir(parents=True, exist_ok=True)
    packages = []
    for package in sorted(metadata['packages'], key=lambda p: (p['name'], p['version'])):
        if package['source'] is None:
            continue
        root = Path(package['manifest_path']).parent
        destination = output / f"{package['name']}-{package['version']}"
        destination.mkdir(exist_ok=True)
        files = sorted(file for file in root.rglob('*') if file.is_file()
                       and not file.is_symlink()
                       and file.name.lower().startswith(('license', 'copying', 'notice', 'unlicense')))
        for source in files:
            target = destination / source.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        packages.append({key: package[key] for key in
                         ('name', 'version', 'license', 'license_file', 'repository', 'source')})
    supplied = Path(__file__).resolve().parent.parent / 'apps/retrieval-kernel/notices'
    records = json.loads((supplied / 'UPSTREAM.json').read_text())
    for record in records:
        relative = Path(record['file'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Retrieval Kernel: upstream notice escapes its owned directory')
        source = supplied / relative
        data = source.read_bytes()
        if hashlib.sha256(data).hexdigest() != record['sha256']:
            raise ValueError('Retrieval Kernel: upstream notice integrity mismatch')
        target = output / 'upstream' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    shutil.copyfile(supplied / 'UPSTREAM.json', output / 'UPSTREAM.json')
    shutil.copyfile(supplied / 'GAPS.json', output / 'GAPS.json')
    (output / 'CRATES.json').write_text(json.dumps(packages, indent=2) + '\n')
    print(f"Packaged license metadata and supplied notices for {len(packages)} locked crates")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    collect(parser.parse_args().output)
