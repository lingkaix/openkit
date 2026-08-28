// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const helperPath = fileURLToPath(new URL('./openkit-file-effect', import.meta.url));
const MAX_FILE_BYTES = 268_435_456;
const CANONICAL_WORKSPACE_SLOT_ROOTS = {
  'artifact-input': '/workspace/artifacts/in',
  cache: '/workspace/.openkit/cache',
  context: '/openkit/context',
  'external-data': '/workspace/data',
  instructions: '/openkit/instructions',
  'main-worktree': '/workspace/worktrees/main',
  scratch: '/workspace/scratch',
  session: '/openkit/session',
  'turn-inputs': '/workspace/inputs',
  'turn-output': '/workspace/outputs',
};
const CANONICAL_SLOT_ROOTS = {
  ...CANONICAL_WORKSPACE_SLOT_ROOTS,
  'package-config': '/openkit/config',
};

/** Runs the exported CLI seam with byte input or an exact injected async stream. */
async function invokeFileEffect(runFileEffect, slotRoots, argv, input = Buffer.alloc(0)) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks = [];
  const stderrChunks = [];

  stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
  const exitCode = await runFileEffect({
    argv,
    stderr,
    stdin: typeof input?.[Symbol.asyncIterator] === 'function' ? input : Readable.from([input]),
    stdout,
    slotRoots,
  });

  return {
    exitCode,
    stderr: Buffer.concat(stderrChunks),
    stdout: Buffer.concat(stdoutChunks),
  };
}

/** Requires one rejected invocation to remain nonzero, output-free, and value-free. */
async function assertRejected(runFileEffect, slotRoots, rejection) {
  const result = await invokeFileEffect(runFileEffect, slotRoots, rejection.argv, rejection.input);
  const diagnostic = result.stderr.toString('utf8');

  assert.notEqual(result.exitCode, 0, rejection.label);
  assert.equal(result.stdout.length, 0, rejection.label);
  assert.ok(diagnostic.trim().length > 0, rejection.label);
  for (const value of rejection.privateValues ?? []) {
    if (value.length > 0) {
      assert.equal(diagnostic.includes(value), false, rejection.label);
    }
  }
}

test('the fixed file-effect helper imports and exports only canonical regular files', async () => {
  await access(helperPath, constants.X_OK);
  const { CANONICAL_SLOT_ROOTS: installedSlotRoots, runFileEffect } = await import(
    pathToFileURL(helperPath).href
  );
  const helperSource = await readFile(helperPath, 'utf8');

  assert.deepEqual(installedSlotRoots, CANONICAL_SLOT_ROOTS);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(installedSlotRoots).filter(([slot]) => slot !== 'package-config')
    ),
    CANONICAL_WORKSPACE_SLOT_ROOTS
  );
  assert.equal(Object.isFrozen(installedSlotRoots), true);
  assert.equal(typeof runFileEffect, 'function');
  assert.match(helperSource, /slotRoots:\s*CANONICAL_SLOT_ROOTS/);
  assert.doesNotMatch(helperSource, /OPENKIT_FILE_EFFECT_(?:ROOT|SLOT)/);

  const testRoot = await mkdtemp(join(tmpdir(), 'openkit-file-effect-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'openkit-file-effect-outside-'));
  const slotRoots = Object.fromEntries(
    Object.keys(CANONICAL_SLOT_ROOTS).map((slotId) => [slotId, join(testRoot, slotId)])
  );

  try {
    await Promise.all(Object.values(slotRoots).map((root) => mkdir(root, { recursive: true })));

    const packageBytes = Buffer.from('{"schemaVersion":3}');
    const packageDigest = `sha256:${createHash('sha256').update(packageBytes).digest('hex')}`;
    const packageImport = await invokeFileEffect(
      runFileEffect,
      slotRoots,
      [
        'reference.import',
        '--slot',
        'package-config',
        '--path',
        'package.json',
        '--length',
        String(packageBytes.length),
        '--sha256',
        packageDigest,
      ],
      packageBytes
    );
    const packageTarget = join(slotRoots['package-config'], 'package.json');

    assert.equal(packageImport.exitCode, 0);
    assert.equal(packageImport.stderr.length, 0);
    assert.equal(
      packageImport.stdout.toString('utf8'),
      `${packageDigest} ${packageBytes.length}\n`
    );
    assert.deepEqual(await readFile(packageTarget), packageBytes);
    assert.equal((await lstat(packageTarget)).mode & 0o777, 0o600);

    const importedBytes = Buffer.from('immutable context bytes\n');
    const importedDigest = `sha256:${createHash('sha256').update(importedBytes).digest('hex')}`;
    const importedPath = 'turn/context.json';
    const imported = await invokeFileEffect(
      runFileEffect,
      slotRoots,
      [
        'reference.import',
        '--slot',
        'context',
        '--path',
        importedPath,
        '--length',
        String(importedBytes.length),
        '--sha256',
        importedDigest,
      ],
      importedBytes
    );
    const importedTarget = join(slotRoots.context, importedPath);
    const importedStat = await lstat(importedTarget);

    assert.equal(imported.exitCode, 0);
    assert.equal(imported.stderr.length, 0);
    assert.equal(imported.stdout.toString('utf8'), `${importedDigest} ${importedBytes.length}\n`);
    assert.deepEqual(await readFile(importedTarget), importedBytes);
    assert.equal(importedStat.isFile(), true);
    assert.equal(importedStat.isSymbolicLink(), false);
    assert.equal(importedStat.mode & 0o777, 0o600);

    const declaredLengthPath = 'turn/declared-length.bin';
    let declaredLengthReads = 0;
    const declaredLengthInput = {
      /** Yields the declared body once and fails if the importer waits for transport EOF. */
      [Symbol.asyncIterator]() {
        return this;
      },
      /** Returns the sole declared body chunk and rejects every later read. */
      async next() {
        declaredLengthReads += 1;
        if (declaredLengthReads === 1) {
          return { done: false, value: importedBytes };
        }
        throw new Error('input requested after declared length');
      },
    };
    const declaredLengthImport = await invokeFileEffect(
      runFileEffect,
      slotRoots,
      [
        'reference.import',
        '--slot',
        'context',
        '--path',
        declaredLengthPath,
        '--length',
        String(importedBytes.length),
        '--sha256',
        importedDigest,
      ],
      declaredLengthInput
    );
    const declaredLengthTarget = join(slotRoots.context, declaredLengthPath);

    assert.equal(declaredLengthImport.exitCode, 0);
    assert.equal(declaredLengthImport.stderr.length, 0);
    assert.equal(
      declaredLengthImport.stdout.toString('utf8'),
      `${importedDigest} ${importedBytes.length}\n`
    );
    assert.equal(declaredLengthReads, 1);
    assert.deepEqual(await readFile(declaredLengthTarget), importedBytes);
    const declaredLengthStat = await lstat(declaredLengthTarget);
    assert.equal(declaredLengthStat.isFile(), true);
    assert.equal(declaredLengthStat.isSymbolicLink(), false);
    assert.equal(declaredLengthStat.mode & 0o777, 0o600);

    const exportedBytes = Buffer.from([0, 1, 2, 10, 13, 255]);
    const exportedPath = 'reports/result.bin';
    const exportedTarget = join(slotRoots['turn-output'], exportedPath);
    await mkdir(dirname(exportedTarget), { recursive: true });
    await writeFile(exportedTarget, exportedBytes, { mode: 0o600 });
    const exported = await invokeFileEffect(runFileEffect, slotRoots, [
      'file.export',
      '--slot',
      'turn-output',
      '--path',
      exportedPath,
      '--max-length',
      String(MAX_FILE_BYTES),
    ]);

    assert.equal(exported.exitCode, 0);
    assert.equal(exported.stderr.length, 0);
    assert.deepEqual(exported.stdout, exportedBytes);

    const optionalAbsentPath = 'reports/no-workspace-changes.json';
    const optionalAbsent = await invokeFileEffect(runFileEffect, slotRoots, [
      'file.export',
      '--slot',
      'turn-output',
      '--path',
      optionalAbsentPath,
      '--max-length',
      String(MAX_FILE_BYTES),
      '--allow-missing',
    ]);
    assert.equal(optionalAbsent.exitCode, 2);
    assert.equal(optionalAbsent.stdout.length, 0);
    assert.equal(optionalAbsent.stderr.length, 0);

    const optionalPresent = await invokeFileEffect(runFileEffect, slotRoots, [
      'file.export',
      '--slot',
      'turn-output',
      '--path',
      exportedPath,
      '--max-length',
      String(MAX_FILE_BYTES),
      '--allow-missing',
    ]);
    assert.equal(optionalPresent.exitCode, 0);
    assert.equal(optionalPresent.stderr.length, 0);
    assert.deepEqual(optionalPresent.stdout, exportedBytes);

    const emptyPath = 'reports/empty';
    await writeFile(join(slotRoots['turn-output'], emptyPath), Buffer.alloc(0), { mode: 0o600 });
    const optionalEmpty = await invokeFileEffect(runFileEffect, slotRoots, [
      'file.export',
      '--slot',
      'turn-output',
      '--path',
      emptyPath,
      '--max-length',
      String(MAX_FILE_BYTES),
      '--allow-missing',
    ]);
    assert.equal(optionalEmpty.exitCode, 0);
    assert.equal(optionalEmpty.stdout.length, 0);
    assert.equal(optionalEmpty.stderr.length, 0);

    const outsideFile = join(outsideRoot, 'outside-target');
    await writeFile(outsideFile, 'outside-original', { mode: 0o600 });
    await symlink(outsideRoot, join(slotRoots.context, 'linked-ancestor'));
    await symlink(outsideFile, join(slotRoots.context, 'linked-target'));
    const hardLinkSource = join(slotRoots['turn-output'], 'hard-source');
    const hardLinkTarget = join(slotRoots['turn-output'], 'hard-target');
    await writeFile(hardLinkSource, 'hard-linked', { mode: 0o600 });
    await link(hardLinkSource, hardLinkTarget);
    await mkdir(join(slotRoots['turn-output'], 'directory-target'));

    /** Builds the exact Rust-owned import argv for one injected slot root. */
    const validImportArgs = (slot, path) => [
      'reference.import',
      '--slot',
      slot,
      '--path',
      path,
      '--length',
      String(importedBytes.length),
      '--sha256',
      importedDigest,
    ];
    for (const rejection of [
      {
        argv: validImportArgs('unknown-private-slot', 'unknown-file'),
        input: importedBytes,
        label: 'unknown slot',
        privateValues: ['unknown-private-slot', 'unknown-file'],
      },
      {
        argv: validImportArgs('package-config', 'adjacent.json'),
        input: importedBytes,
        label: 'adjacent package config path',
        privateValues: ['adjacent.json'],
      },
      {
        argv: [
          'file.export',
          '--slot',
          'package-config',
          '--path',
          'package.json',
          '--max-length',
          String(MAX_FILE_BYTES),
        ],
        label: 'package config export',
        privateValues: ['package.json'],
      },
      {
        argv: [
          'file.export',
          '--slot',
          'context',
          '--path',
          importedPath,
          '--max-length',
          String(MAX_FILE_BYTES),
        ],
        label: 'read-only export slot',
        privateValues: [importedPath],
      },
      {
        argv: [
          'file.export',
          '--slot',
          'turn-output',
          '--path',
          'missing-parent/file',
          '--max-length',
          String(MAX_FILE_BYTES),
          '--allow-missing',
        ],
        label: 'optional export with a missing parent',
        privateValues: ['missing-parent/file'],
      },
      {
        argv: validImportArgs('turn-output', 'wrong-operation'),
        input: importedBytes,
        label: 'wrong import slot',
        privateValues: ['wrong-operation'],
      },
      ...['../escape', '/absolute', String.raw`back\slash`, './dot', ''].map((path) => ({
        argv: validImportArgs('context', path),
        input: importedBytes,
        label: `invalid path ${JSON.stringify(path)}`,
        privateValues: [path],
      })),
      {
        argv: validImportArgs('context', 'linked-ancestor/escaped'),
        input: importedBytes,
        label: 'symlink ancestor',
        privateValues: ['linked-ancestor/escaped'],
      },
      {
        argv: validImportArgs('context', 'linked-target'),
        input: importedBytes,
        label: 'symlink target',
        privateValues: ['linked-target'],
      },
      {
        argv: [
          'file.export',
          '--slot',
          'turn-output',
          '--path',
          'hard-target',
          '--max-length',
          String(MAX_FILE_BYTES),
        ],
        label: 'hard-linked export',
        privateValues: ['hard-target'],
      },
      {
        argv: [
          'file.export',
          '--slot',
          'turn-output',
          '--path',
          'directory-target',
          '--max-length',
          String(MAX_FILE_BYTES),
        ],
        label: 'non-regular export',
        privateValues: ['directory-target'],
      },
      {
        argv: ['reference.import', '--slot'],
        label: 'malformed arguments',
        privateValues: [],
      },
      {
        argv: [...validImportArgs('context', 'duplicate'), '--slot', 'context'],
        input: importedBytes,
        label: 'duplicate arguments',
        privateValues: ['duplicate'],
      },
      {
        argv: [...validImportArgs('context', 'extra'), 'private-extra-argument'],
        input: importedBytes,
        label: 'extra arguments',
        privateValues: ['extra', 'private-extra-argument'],
      },
      {
        argv: ['file.export', '--slot', 'turn-output', '--path', exportedPath, '--max-length', '1'],
        label: 'noncanonical export ceiling',
        privateValues: [exportedPath],
      },
    ]) {
      await assertRejected(runFileEffect, slotRoots, rejection);
    }
    await assert.rejects(access(join(outsideRoot, 'escaped')));
    assert.equal(await readFile(outsideFile, 'utf8'), 'outside-original');

    const integrityRoot = join(slotRoots.context, 'integrity');
    await mkdir(integrityRoot);
    const existingTarget = join(integrityRoot, 'existing');
    await writeFile(existingTarget, 'existing-original', { mode: 0o600 });
    for (const rejection of [
      {
        argv: [
          ...validImportArgs('context', 'integrity/wrong-digest').slice(0, -1),
          `sha256:${'0'.repeat(64)}`,
        ],
        input: importedBytes,
        label: 'wrong digest',
        privateValues: [`sha256:${'0'.repeat(64)}`],
      },
      {
        argv: validImportArgs('context', 'integrity/wrong-length').map((value, index, values) =>
          values[index - 1] === '--length' ? String(importedBytes.length + 1) : value
        ),
        input: importedBytes,
        label: 'wrong length',
        privateValues: [],
      },
      {
        argv: validImportArgs('context', 'integrity/oversized-chunk'),
        input: Buffer.concat([importedBytes, Buffer.from('extra')]),
        label: 'oversized input chunk',
        privateValues: [],
      },
      {
        argv: validImportArgs('context', 'integrity/oversized').map((value, index, values) =>
          values[index - 1] === '--length' ? String(MAX_FILE_BYTES + 1) : value
        ),
        input: Buffer.alloc(0),
        label: 'oversized import',
        privateValues: [],
      },
      {
        argv: validImportArgs('context', 'integrity/existing'),
        input: importedBytes,
        label: 'existing import destination',
        privateValues: [],
      },
    ]) {
      const before = await readdir(integrityRoot);
      await assertRejected(runFileEffect, slotRoots, rejection);
      assert.deepEqual(await readdir(integrityRoot), before, rejection.label);
    }
    assert.equal(await readFile(existingTarget, 'utf8'), 'existing-original');
  } finally {
    await rm(testRoot, { force: true, recursive: true });
    await rm(outsideRoot, { force: true, recursive: true });
  }
});
