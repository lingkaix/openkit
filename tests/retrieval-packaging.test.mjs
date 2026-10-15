// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const archiveName = 'mecab-ipadic-2.7.0-20250920.tar.gz';
const expected = 'a7ba9f645ffe7094e56ae1c4a81d100df8fbb1e28bbe1792622e9728e162db3d';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('vendored IPADIC is exact, caches without downloads, retains COPYING, and rejects cache corruption', () => {
  const archive = join(root, 'apps/retrieval-kernel/vendor', archiveName);
  assert.equal(sha(readFileSync(archive)), expected);
  const cache = mkdtempSync(join(tmpdir(), 'retrieval-dictionary-supply-'));
  const notice = join(cache, 'COPYING');
  const run = () =>
    spawnSync(
      'python3',
      [join(root, 'scripts/retrieval-dictionary.py'), '--cache', cache, '--notice', notice],
      { encoding: 'utf8' }
    );
  const initial = run();
  assert.equal(initial.status, 0, initial.stderr);
  const cached = join(cache, '5.3.0-fmt2', archiveName);
  assert.equal(sha(readFileSync(cached)), expected);
  assert.deepEqual(
    readFileSync(notice),
    readFileSync(join(root, 'apps/retrieval-kernel/vendor/IPADIC-COPYING'))
  );
  const reused = run();
  assert.equal(reused.status, 0, reused.stderr);
  writeFileSync(cached, 'corrupt cached dictionary');
  const corrupt = run();
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /IPADIC archive SHA-256 mismatch/);
  assert.equal(readFileSync(cached, 'utf8'), 'corrupt cached dictionary');
});

test('every vendored missing-crate notice has exact revision and byte provenance', () => {
  const notices = join(root, 'apps/retrieval-kernel/notices');
  const records = JSON.parse(readFileSync(join(notices, 'UPSTREAM.json'), 'utf8'));
  assert.ok(records.length > 0);
  for (const record of records) {
    assert.match(record.revision, /^[a-f0-9]{40}$/);
    assert.ok(record.crate && record.version);
    assert.ok(record.url.startsWith('https://raw.githubusercontent.com/'));
    assert.ok(record.url.includes(`/${record.revision}/`));
    assert.equal(sha(readFileSync(join(notices, record.file))), record.sha256);
  }
  assert.ok(records.some((record) => record.crate === 'jieba-rs' && record.version === '0.11.0'));
});

// Runtime supply must be selected before NanoCore can serve Tasks from a clean checkout.
test('NanoCore build orders the kernel executable before its runtime consumer', () => {
  const result = spawnSync(
    join(root, 'node_modules/.bin/turbo'),
    ['run', 'build', '--filter=@openkit/nanocore', '--dry=json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  assert.equal(result.status, 0, result.stderr);
  const { tasks } = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  const kernel = tasks.find((task) => task.taskId === '@openkit/retrieval-kernel#build');
  const nanocore = tasks.find((task) => task.taskId === '@openkit/nanocore#build');
  assert.ok(kernel, 'NanoCore build must supply the retrieval kernel executable');
  assert.ok(nanocore?.dependencies.includes(kernel.taskId), 'kernel must precede NanoCore build');
});
