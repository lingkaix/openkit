"""Unit self-checks for notice comparison and driver control flow, not image acceptance."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'verify-image-notices.py'
FILES = {
    'IPADIC-COPYING': b'Dictionary redistribution notice\r\n\xff\n',
    'crates/CRATES.json': b'[{"name":"example","version":"1","license":"MIT"}]\n',
    'crates/GAPS.json': b'[]\n',
    'crates/UPSTREAM.json': b'[{"file":"example-1/NOTICE","sha256":"fixed"}]\n',
    'crates/ELECTIONS.json': b'[{"crate":"example","elected_license":"Apache-2.0"}]\n',
    'crates/example-1/LICENSE': b'Exact license bytes.\r\n',
    'crates/upstream/example-1/NOTICE': b'Exact upstream attribution.\n',
    'crates/elected/example-1/LICENSE-APACHE-2.0': b'Exact elected license.\n',
}
IMAGE_ID = 'sha256:' + 'a' * 64
ARM_ID = 'sha256:' + 'b' * 64
CONTAINER_ID = 'c' * 64
REFERENCE = 'example.invalid/openkit:mutable'


def write_tree(destination):
    """Write independently fixed source bytes without invoking Cargo or Docker."""
    for relative, content in FILES.items():
        path = destination / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)


def leaves(value):
    """Inspect report values without prescribing an unrequested JSON field layout."""
    if isinstance(value, dict):
        return [leaf for child in value.values() for leaf in leaves(child)]
    if isinstance(value, list):
        return [leaf for child in value for leaf in leaves(child)]
    return [value]


class VerifierTests(unittest.TestCase):
    """Use real temporary files and simulated Docker replies only for unit checks."""

    @classmethod
    def setUpClass(cls):
        """Load the public script only after the implementation file exists."""
        spec = importlib.util.spec_from_file_location('image_notice_verifier', SCRIPT)
        cls.verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.verifier)

    def setUp(self):
        """Keep all source, extracted and unrelated bytes inside one owned temporary root."""
        temporary = tempfile.TemporaryDirectory(prefix='image-notices-unit-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.expected = self.root / 'expected'
        self.actual = self.root / 'actual'
        write_tree(self.expected)
        write_tree(self.actual)

    def test_exact_tree_and_each_notice_kind(self):
        """Every supplied byte matters, including metadata, provenance and dictionary notices."""
        self.assertEqual(self.verifier.compare_notice_trees(self.expected, self.actual), len(FILES))
        for relative, content in FILES.items():
            with self.subTest(relative=relative):
                path = self.actual / relative
                path.write_bytes(content + b'changed')
                with self.assertRaises(ValueError):
                    self.verifier.compare_notice_trees(self.expected, self.actual)
                path.write_bytes(content)

    def test_gaps_must_be_an_empty_array_in_both_trees(self):
        """Identical trees cannot pass when source obligations remain or GAPS has another shape."""
        for content in [b'["unresolved"]\n', b'{}\n', b'null\n', b'invalid JSON']:
            for tree in [self.expected, self.actual]:
                with self.subTest(content=content, tree=tree.name):
                    (self.expected / 'crates/GAPS.json').write_bytes(FILES['crates/GAPS.json'])
                    (self.actual / 'crates/GAPS.json').write_bytes(FILES['crates/GAPS.json'])
                    (tree / 'crates/GAPS.json').write_bytes(content)
                    with self.assertRaises(ValueError):
                        self.verifier.compare_notice_trees(self.expected, self.actual)
            (self.expected / 'crates/GAPS.json').write_bytes(content)
            (self.actual / 'crates/GAPS.json').write_bytes(content)
            with self.assertRaises(ValueError):
                self.verifier.compare_notice_trees(self.expected, self.actual)

    def test_missing_and_extra_files_are_rejected(self):
        """A subset or superset is not an exact packaged notice tree."""
        missing = self.actual / 'IPADIC-COPYING'
        missing.unlink()
        with self.assertRaises(ValueError):
            self.verifier.compare_notice_trees(self.expected, self.actual)
        missing.write_bytes(FILES['IPADIC-COPYING'])
        (self.actual / 'unexpected').write_bytes(b'extra')
        with self.assertRaises(ValueError):
            self.verifier.compare_notice_trees(self.expected, self.actual)

    def test_symlink_files_and_directories_are_rejected_on_either_side(self):
        """Matching external bytes do not make links valid notice entries."""
        for tree in [self.expected, self.actual]:
            with self.subTest(tree=tree.name, kind='file'):
                path = tree / 'IPADIC-COPYING'
                outside = self.root / 'outside-file'
                outside.write_bytes(path.read_bytes())
                path.unlink()
                path.symlink_to(outside)
                with self.assertRaises(ValueError):
                    self.verifier.compare_notice_trees(self.expected, self.actual)
                path.unlink()
                path.write_bytes(FILES['IPADIC-COPYING'])
            with self.subTest(tree=tree.name, kind='directory'):
                path = tree / 'crates/upstream'
                outside = self.root / f'outside-{tree.name}'
                shutil.move(path, outside)
                path.symlink_to(outside, target_is_directory=True)
                with self.assertRaises(ValueError):
                    self.verifier.compare_notice_trees(self.expected, self.actual)
                path.unlink()
                shutil.move(outside, path)

    def test_nonregular_entries_are_rejected_on_either_side(self):
        """A socket inode must fail validation without attempting a blocking read."""
        for tree in [self.expected, self.actual]:
            with self.subTest(tree=tree.name):
                path = tree / 'special'
                with contextlib.chdir(tree), socket.socket(socket.AF_UNIX) as endpoint:
                    endpoint.bind('special')
                    with self.assertRaises(ValueError):
                        self.verifier.compare_notice_trees(self.expected, self.actual)
                path.unlink()

    def docker_double(self, *, platform='linux/amd64', architecture='amd64',
                      operating_system='linux', image_id=IMAGE_ID,
                      container_id=CONTAINER_ID, failure=None):
        """Simulate command replies for driver checks; no actual image is inspected."""
        calls = []

        def run(command, *args, **kwargs):
            command = [str(part) for part in command]
            calls.append(command)
            self.assertEqual(command[0], 'docker')
            self.assertFalse(set(command[1:]) & {'pull', 'run', 'start', 'exec', 'stop'})
            self.assertGreater(kwargs.get('timeout', 0), 0)
            operation = next((name for name in ['inspect', 'create', 'cp', 'rm']
                              if name in command[1:]), None)
            self.assertIsNotNone(operation, command)
            if failure == f'{operation}-timeout':
                raise subprocess.TimeoutExpired(command, kwargs['timeout'])
            if failure == operation:
                if kwargs.get('check'):
                    raise subprocess.CalledProcessError(19, command, stderr='simulated failure')
                return subprocess.CompletedProcess(command, 19, stdout='', stderr='simulated failure')
            output = ''
            if operation == 'inspect':
                self.assertIn(REFERENCE, command)
                self.assertTrue(platform in command or f'--platform={platform}' in command)
                self.assertTrue('--format' in command or any(part.startswith('--format=') for part in command))
                output = json.dumps({'Id': image_id, 'Os': operating_system,
                                     'Architecture': architecture})
            elif operation == 'create':
                self.assertIn(image_id, command)
                self.assertNotIn(REFERENCE, command)
                self.assertIn('--pull=never', command)
                output = container_id + '\n'
            elif operation == 'cp':
                self.assertIn(CONTAINER_ID + ':/usr/local/share/licenses/retrieval-kernel/.', command)
                destination = Path(command[-1])
                write_tree(destination)
                if failure == 'compare':
                    (destination / 'IPADIC-COPYING').write_bytes(b'tampered extraction')
            elif operation == 'rm':
                targets = [part for part in command[command.index('rm') + 1:] if not part.startswith('-')]
                self.assertEqual(targets, [CONTAINER_ID])
            if not (kwargs.get('text') or kwargs.get('encoding') or kwargs.get('universal_newlines')):
                output = output.encode()
            return subprocess.CompletedProcess(command, 0, stdout=output, stderr='')

        return calls, run

    def test_driver_pins_image_and_removes_only_its_stopped_container(self):
        """A mutable input is inspected, then only its immutable image ID is used for extraction."""
        for platform, image_id in [('linux/amd64', IMAGE_ID), ('linux/arm64', ARM_ID)]:
            with self.subTest(platform=platform):
                calls, run = self.docker_double(platform=platform,
                                              architecture=platform.split('/')[1], image_id=image_id)
                with patch.object(self.verifier.subprocess, 'run', side_effect=run):
                    result = self.verifier.verify_image(REFERENCE, platform, self.expected)
                values = leaves(result)
                self.assertIn(platform, values)
                self.assertIn(image_id, values)
                self.assertIn(len(FILES), values)
                self.assertEqual(sum('create' in call for call in calls), 1)
                self.assertEqual(sum('cp' in call for call in calls), 1)
                self.assertEqual(sum('rm' in call for call in calls), 1)
                self.assertIn('rm', calls[-1])

    def test_wrong_platform_is_rejected_before_container_creation(self):
        """A wrong architecture or non-Linux image must not reach container creation."""
        for platform, settings in [
            ('linux/amd64', {'architecture': 'arm64'}),
            ('linux/arm64', {'architecture': 'amd64'}),
            ('linux/amd64', {'operating_system': 'windows'}),
        ]:
            with self.subTest(platform=platform, settings=settings):
                calls, run = self.docker_double(platform=platform, **settings)
                with patch.object(self.verifier.subprocess, 'run', side_effect=run):
                    with self.assertRaises((ValueError, RuntimeError)):
                        self.verifier.verify_image(REFERENCE, platform, self.expected)
                self.assertFalse(any('create' in call or 'rm' in call for call in calls))

    def test_copy_check_and_timeout_failures_clean_up_the_owned_container(self):
        """After a returned container ID, extraction and comparison failures still remove it."""
        for failure in ['cp', 'cp-timeout', 'compare']:
            with self.subTest(failure=failure):
                calls, run = self.docker_double(failure=failure)
                with patch.object(self.verifier.subprocess, 'run', side_effect=run):
                    with self.assertRaises((ValueError, RuntimeError, subprocess.SubprocessError)):
                        self.verifier.verify_image(REFERENCE, 'linux/amd64', self.expected)
                self.assertEqual(sum('create' in call for call in calls), 1)
                self.assertEqual(sum('rm' in call for call in calls), 1)
                self.assertIn('rm', calls[-1])

    def test_cleanup_failure_cannot_return_image_success(self):
        """A failed or timed-out removal must not be reported as a completed image check."""
        for failure in ['rm', 'rm-timeout']:
            with self.subTest(failure=failure):
                calls, run = self.docker_double(failure=failure)
                with patch.object(self.verifier.subprocess, 'run', side_effect=run):
                    with self.assertRaises((ValueError, RuntimeError, subprocess.SubprocessError)):
                        self.verifier.verify_image(REFERENCE, 'linux/amd64', self.expected)
                self.assertEqual(sum('cp' in call for call in calls), 1)
                self.assertEqual(sum('rm' in call for call in calls), 1)

    def test_unconfirmed_creation_never_removes_an_unowned_container(self):
        """Without a returned owned container ID, failure cannot authorize guessed cleanup."""
        for failure in ['inspect-timeout', 'create', 'create-timeout']:
            with self.subTest(failure=failure):
                calls, run = self.docker_double(failure=failure)
                with patch.object(self.verifier.subprocess, 'run', side_effect=run):
                    with self.assertRaises((ValueError, RuntimeError, subprocess.SubprocessError)):
                        self.verifier.verify_image(REFERENCE, 'linux/amd64', self.expected)
                self.assertFalse(any('cp' in call or 'rm' in call for call in calls))

    def test_malformed_image_or_container_identity_fails_closed(self):
        """Names or malformed IDs cannot become an immutable extraction or cleanup target."""
        for settings in [{'image_id': 'sha256:not-a-digest'},
                         {'image_id': 'sha256:' + 'A' * 64},
                         {'container_id': 'unconfirmed-name'}]:
            with self.subTest(settings=settings):
                calls, run = self.docker_double(**settings)
                with patch.object(self.verifier.subprocess, 'run', side_effect=run):
                    with self.assertRaises((ValueError, RuntimeError)):
                        self.verifier.verify_image(REFERENCE, 'linux/amd64', self.expected)
                self.assertFalse(any('cp' in call or 'rm' in call for call in calls))
                if 'image_id' in settings:
                    self.assertFalse(any('create' in call for call in calls))

    def test_both_platform_arguments_are_required(self):
        """A one-platform request cannot claim the two-platform predicate."""
        for arguments in [[], ['--amd64-image', 'amd'], ['--arm64-image', 'arm']]:
            with self.subTest(arguments=arguments):
                with patch.object(self.verifier, 'verify_image') as verify:
                    with contextlib.redirect_stderr(io.StringIO()):
                        with self.assertRaises(SystemExit) as failure:
                            self.verifier.main(arguments)
                self.assertNotEqual(failure.exception.code, 0)
                verify.assert_not_called()

    def test_main_reports_both_platforms_and_immutable_identities(self):
        """A successful unit driver report includes both completed checks, without real image proof."""
        results = [{'platform': 'linux/amd64', 'image_id': IMAGE_ID, 'files_verified': len(FILES)},
                   {'platform': 'linux/arm64', 'image_id': ARM_ID, 'files_verified': len(FILES)}]
        output = io.StringIO()
        with patch.object(self.verifier, 'prepare_expected', side_effect=write_tree):
            with patch.object(self.verifier, 'verify_image', side_effect=results) as verify:
                with contextlib.redirect_stdout(output):
                    result = self.verifier.main(['--amd64-image', 'amd', '--arm64-image', 'arm'])
        self.assertEqual(result, 0)
        report = leaves(json.loads(output.getvalue()))
        for expected in ['linux/amd64', 'linux/arm64', IMAGE_ID, ARM_ID]:
            self.assertIn(expected, report)
        self.assertEqual([(call.args[0], call.args[1]) for call in verify.call_args_list],
                         [('amd', 'linux/amd64'), ('arm', 'linux/arm64')])

    def test_second_platform_failure_cannot_emit_a_pass(self):
        """An earlier successful platform cannot become an overall success after a later failure."""
        output = io.StringIO()
        with patch.object(self.verifier, 'prepare_expected', side_effect=write_tree):
            with patch.object(self.verifier, 'verify_image', side_effect=[
                {'platform': 'linux/amd64', 'image_id': IMAGE_ID, 'files_verified': len(FILES)},
                ValueError('simulated arm64 mismatch'),
            ]) as verify:
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                    result = self.verifier.main(['--amd64-image', 'amd', '--arm64-image', 'arm'])
        self.assertNotEqual(result, 0)
        self.assertEqual(verify.call_count, 2)
        self.assertNotIn('PASS', output.getvalue().upper())
        self.assertEqual(output.getvalue(), '', 'no result report before both platforms complete')


if __name__ == '__main__':
    unittest.main()
