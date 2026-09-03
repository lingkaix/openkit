// openkit-test-container-subject
// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const image = process.env.OPENKIT_APP_IMAGE ?? 'openkit/app:dev';
const enabled = process.env.OPENKIT_TEST_APP_IMAGE_RECOVERY === '1';
const temporaryDirectories = [];

/** Runs one Docker command and retains both output streams in memory. */
function runDocker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.redactOutput) {
      throw new Error(`docker exited with status ${result.status ?? 'unknown'}; output suppressed`);
    }
    const output = [
      `docker exited with status ${result.status ?? 'unknown'}`,
      result.stderr.trim(),
      result.stdout.trim(),
    ]
      .filter(Boolean)
      .join('\n');
    throw new Error(output);
  }
  return {
    stderr: result.stderr.trim(),
    stdout: result.stdout.trim(),
  };
}

/** Builds the one-shot command prefix for disposable bind mounts. */
function operatorArgs(dataRoot, outputRoot) {
  return [
    'run',
    '--rm',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--mount',
    `type=bind,source=${dataRoot},target=/data/openkit`,
    '--mount',
    `type=bind,source=${outputRoot},target=/recovery`,
    image,
    'openkit-operator',
  ];
}

/** Parses the exact secret-free completion projection. */
function parseRecoverySummary(text, expiresAt) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Recovery completion output was not valid JSON.');
  }
  assert.deepEqual(Object.keys(value).sort(), [
    'auditEventId',
    'expiresAt',
    'ownerUserId',
    'status',
    'tokenId',
  ]);
  assert.equal(value.expiresAt, expiresAt);
  assert.equal(value.ownerUserId, 'user_image_recovery');
  assert.equal(value.status, 'completed');
  assert.equal(typeof value.auditEventId, 'string');
  assert.equal(typeof value.tokenId, 'string');
  return value;
}

before(() => {
  if (!enabled) return;
  runDocker(['version', '--format', '{{.Server.Version}}']);
  assert.throws(
    () => runDocker(['image', 'inspect', 'openkit-harness-self-check@@invalid']),
    /status [1-9][0-9]*/u
  );
  process.stdout.write(
    'App-image smoke harness self-check PASS (success=version failure=invalid-reference)\n'
  );
});

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true });
});

test('app image runs stopped-server administrator recovery through disposable mounts', {
  skip: process.env.OPENKIT_TEST_APP_IMAGE_RECOVERY !== '1',
}, () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-app-recovery-data-'));
  const outputRoot = mkdtempSync(join(tmpdir(), 'openkit-app-recovery-output-'));
  temporaryDirectories.push(dataRoot, outputRoot);
  const user = `${process.getuid()}:${process.getgid()}`;
  const dataMount = `type=bind,source=${dataRoot},target=/data/openkit`;

  runDocker(['run', '--rm', image, 'openkit-app-smoke']);
  runDocker([
    'run',
    '--rm',
    '--user',
    user,
    '--mount',
    dataMount,
    '--entrypoint',
    'node',
    image,
    '--input-type=module',
    '--eval',
    `
        import { openCoreDb } from 'file:///app/nanocore/dist/storage/db.js';
        import { applyMigrations } from 'file:///app/nanocore/dist/storage/migrate.js';
        const coreDb = openCoreDb('/data/openkit');
        try {
          applyMigrations(coreDb);
          const now = Date.now();
          coreDb.sqlite.prepare(
            'INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, status) VALUES (?, ?, ?, 1, ?, ?, ?)'
          ).run('user_image_recovery', 'Image Recovery User', 'image-recovery@example.com', now, now, 'active');
        } finally {
          coreDb.sqlite.close();
        }
      `,
  ]);

  const discovered = JSON.parse(
    runDocker([
      ...operatorArgs(dataRoot, outputRoot),
      'admin',
      'recovery-users',
      '--data-root',
      '/data/openkit',
    ]).stdout
  );
  assert.deepEqual(discovered, [
    {
      displayName: 'Image Recovery User',
      email: 'image-recovery@example.com',
      userId: 'user_image_recovery',
    },
  ]);

  const expiresAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  const recoveryCommand = [
    ...operatorArgs(dataRoot, outputRoot),
    'admin',
    'recover-access',
    '--data-root',
    '/data/openkit',
    '--owner-user-id',
    'user_image_recovery',
    '--expires-at',
    expiresAt,
    '--output',
    '/recovery/admin-recovery.json',
    '--confirm',
    `issue-server-admin-token:user_image_recovery:${expiresAt}`,
  ];
  const firstRun = runDocker(recoveryCommand, { redactOutput: true });
  const envelopePath = join(outputRoot, 'admin-recovery.json');
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(envelopePath, 'utf8'));
  } catch {
    throw new Error('Recovery envelope was not valid JSON.');
  }
  if (typeof envelope.token !== 'string' || !/^okt_[A-Za-z0-9_-]+$/u.test(envelope.token)) {
    throw new Error('Recovery envelope did not contain one valid token.');
  }
  if (firstRun.stdout.includes(envelope.token) || firstRun.stderr.includes(envelope.token)) {
    throw new Error('Recovery command exposed credential material.');
  }
  const first = parseRecoverySummary(firstRun.stdout, expiresAt);
  assert.equal(statSync(envelopePath).mode & 0o777, 0o600);
  const retryRun = runDocker(recoveryCommand, { redactOutput: true });
  if (retryRun.stdout.includes(envelope.token) || retryRun.stderr.includes(envelope.token)) {
    throw new Error('Recovery retry exposed credential material.');
  }
  const retry = parseRecoverySummary(retryRun.stdout, expiresAt);
  assert.deepEqual(retry, first);
  process.stdout.write('OpenKit app image administrator recovery smoke PASS\n');
});
