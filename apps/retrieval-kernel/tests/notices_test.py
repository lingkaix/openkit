"""Exercise the real notice collector without altering repository notice bytes."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
SUPPLIED = ROOT / 'apps/retrieval-kernel/notices'
APACHE_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'


class ElectedNoticeTests(unittest.TestCase):
    """An elected license must be copied exactly and must fail closed on damage."""

    @classmethod
    def setUpClass(cls):
        """Read the real locked package metadata as the independent provenance oracle."""
        metadata = json.loads(subprocess.check_output(
            ['cargo', 'metadata', '--locked', '--offline', '--format-version', '1'],
            cwd=ROOT / 'apps/retrieval-kernel',
        ))
        cls.htmlescape = next(p for p in metadata['packages'] if p['name'] == 'htmlescape')

    def setUp(self):
        """Copy collector inputs into an isolated source tree for corruption checks."""
        self.temporary = tempfile.TemporaryDirectory(prefix='retrieval-notices-')
        self.addCleanup(self.temporary.cleanup)
        fixture = Path(self.temporary.name)
        self.supplied = fixture / 'apps/retrieval-kernel/notices'
        shutil.copytree(SUPPLIED, self.supplied)
        self.script = fixture / 'scripts/retrieval-notices.py'
        self.script.parent.mkdir()
        shutil.copyfile(ROOT / 'scripts/retrieval-notices.py', self.script)
        self.output = fixture / 'output'

    def collect(self):
        """Execute the shipped collector with real Cargo metadata and fixture-owned bytes."""
        return subprocess.run(
            ['python3', str(self.script), '--output', str(self.output)],
            cwd=ROOT / 'apps/retrieval-kernel',
            capture_output=True,
            text=True,
            env=os.environ.copy(),
            check=False,
        )

    def test_elected_license_and_provenance_are_packaged_exactly(self):
        """Apache bytes and the election survive packaging without invented attribution."""
        result = self.collect()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.output / 'ELECTIONS.json').is_file(),
                        'elected provenance must be included in the package')
        records = json.loads((self.output / 'ELECTIONS.json').read_text())
        self.assertEqual((self.output / 'ELECTIONS.json').read_bytes(),
                         (SUPPLIED / 'ELECTIONS.json').read_bytes())
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual((record['crate'], record['version']), ('htmlescape', '0.3.1'))
        self.assertEqual(record['elected_license'], 'Apache-2.0')
        self.assertEqual(record['url'], 'https://www.apache.org/licenses/LICENSE-2.0.txt')
        self.assertEqual(record['sha256'], APACHE_SHA256)
        self.assertIn('OpenKit', record['record_owner'])
        self.assertEqual(record['manifest'], {
            'license': self.htmlescape['license'], 'authors': self.htmlescape['authors'],
        })
        self.assertEqual(record['archive']['sha256'],
                         'e9025058dae765dee5070ec375f591e2ba14638c63feff74f13805a72e523163')
        self.assertEqual(record['revision'], '1699b539179798e705ad8464128492a0a0092876')
        self.assertIn('no NOTICE file', record['upstream']['notice'])
        self.assertEqual(record['source_notices'], [])
        package = Path(self.htmlescape['manifest_path']).parent
        self.assertEqual(hashlib.sha256((package / 'Cargo.toml').read_bytes()).hexdigest(),
                         record['manifest_sha256'])
        for source in record['source_files']:
            self.assertEqual(hashlib.sha256((package / source['file']).read_bytes()).hexdigest(),
                             source['sha256'])
        license_bytes = (self.output / 'elected' / record['file']).read_bytes()
        self.assertEqual(license_bytes, (SUPPLIED / record['file']).read_bytes())
        self.assertEqual(hashlib.sha256(license_bytes).hexdigest(), APACHE_SHA256)

    def test_corrupt_elected_license_is_rejected(self):
        """A changed canonical license cannot be shipped under the recorded digest."""
        (self.supplied / 'htmlescape-0.3.1/LICENSE-APACHE-2.0').write_bytes(b'corrupt')
        result = self.collect()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('elected notice integrity mismatch', result.stderr)

    def test_elected_notice_cannot_escape_its_source_directory(self):
        """An election record cannot copy an unowned file through a relative traversal."""
        records = json.loads((self.supplied / 'ELECTIONS.json').read_text())
        records[0]['file'] = '../outside'
        (self.supplied / 'ELECTIONS.json').write_text(json.dumps(records))
        result = self.collect()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('elected notice escapes its owned directory', result.stderr)


if __name__ == '__main__':
    unittest.main()
