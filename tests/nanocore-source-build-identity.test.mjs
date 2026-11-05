import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSource } from '../apps/nanocore/scripts/build-source.mjs';
import { writeSourceBuildIdentity } from '../apps/nanocore/scripts/write-source-build-identity.mjs';

/** Uses an actual committed repository, not an invented release SHA. */
function fixture(t, initialize = true) {
  const root = mkdtempSync(join(tmpdir(), 'source-build-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const output = join(root, 'output', 'identity.json');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  if (initialize) {
    git('init', '-q');
    writeFileSync(join(repo, 'source.txt'), 'Committed source.\n');
    git('add', 'source.txt');
    git(
      '-c',
      'user.name=Build fixture',
      '-c',
      'user.email=build@example.com',
      'commit',
      '-qm',
      'fixture'
    );
  }
  return { repo, output, git };
}

test('records the exact actual clean Git commit as an untagged source build', (t) => {
  const f = fixture(t);
  assert.equal(writeSourceBuildIdentity(f.repo, f.output), true);
  assert.deepEqual(JSON.parse(readFileSync(f.output, 'utf8')), {
    releaseTag: null,
    sourceCommit: f.git('rev-parse', 'HEAD'),
  });
});

test('does not attribute changed tracked source to its prior commit or retain a stale identity', (t) => {
  const f = fixture(t);
  assert.equal(writeSourceBuildIdentity(f.repo, f.output), true);
  writeFileSync(join(f.repo, 'source.txt'), 'Changed source.\n');
  assert.equal(writeSourceBuildIdentity(f.repo, f.output), false);
  assert.equal(existsSync(f.output), false);
});

test('does not attribute untracked source to an existing commit', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'new-source.txt'), 'Uncommitted source.\n');
  assert.equal(writeSourceBuildIdentity(f.repo, f.output), false);
  assert.equal(existsSync(f.output), false);
});

test('does not mistake an ignored nested source copy for its enclosing repository', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, '.gitignore'), 'copy/\n');
  f.git('add', '.gitignore');
  f.git(
    '-c',
    'user.name=Build fixture',
    '-c',
    'user.email=build@example.com',
    'commit',
    '-qm',
    'ignore copy'
  );
  const copy = join(f.repo, 'copy');
  mkdirSync(copy);
  writeFileSync(join(copy, 'source.txt'), 'Not the committed source.\n');
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(writeSourceBuildIdentity(copy, f.output), false);
  assert.equal(existsSync(f.output), false);
});

test('finalizes committed source after restoring unchanged compiled bytes from a dirty build', (t) => {
  const f = fixture(t);
  const compiled = join(f.repo, '..', 'compiled.js');
  writeFileSync(join(f.repo, 'source.txt'), 'New source bytes.\n');
  const restoreCompiled = () => {
    assert.equal(existsSync(f.output), false);
    writeFileSync(compiled, 'Compiled new source bytes.\n');
  };
  assert.equal(
    buildSource({ repoRoot: f.repo, outputPath: f.output, compile: restoreCompiled }),
    false
  );
  f.git('add', 'source.txt');
  f.git(
    '-c',
    'user.name=Build fixture',
    '-c',
    'user.email=build@example.com',
    'commit',
    '-qm',
    'new source'
  );
  assert.equal(
    buildSource({ repoRoot: f.repo, outputPath: f.output, compile: restoreCompiled }),
    true
  );
  assert.equal(JSON.parse(readFileSync(f.output, 'utf8')).sourceCommit, f.git('rev-parse', 'HEAD'));
});

test('invalidates the prior identity before a real failing TypeScript build emits changed JavaScript', (t) => {
  const f = fixture(t);
  assert.equal(writeSourceBuildIdentity(f.repo, f.output), true);
  const source = join(f.repo, 'broken.ts');
  const output = join(f.repo, 'compiled');
  writeFileSync(source, 'export const value: string = 42;\n');
  f.git('add', 'broken.ts');
  f.git(
    '-c',
    'user.name=Build fixture',
    '-c',
    'user.email=build@example.com',
    'commit',
    '-qm',
    'broken source'
  );
  const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
  assert.throws(() =>
    buildSource({
      repoRoot: f.repo,
      outputPath: f.output,
      compile: () => {
        assert.equal(existsSync(f.output), false);
        execFileSync(
          process.execPath,
          [
            compiler,
            source,
            '--outDir',
            output,
            '--noEmitOnError',
            'false',
            '--skipLibCheck',
            '--target',
            'es2022',
          ],
          {
            cwd: f.repo,
            stdio: 'pipe',
          }
        );
      },
    })
  );
  assert.equal(existsSync(join(output, 'broken.js')), true);
  assert.equal(existsSync(f.output), false);
});

test('keeps native build failures with the outer owner, not source compilation', (t) => {
  const f = fixture(t);
  const nano = join(f.repo, 'apps/nanocore');
  const rust = join(f.repo, 'packages/retrieval-kernel');
  mkdirSync(nano, { recursive: true });
  mkdirSync(rust, { recursive: true });
  writeFileSync(join(f.repo, '.gitignore'), 'node_modules/\n.turbo/\n**/dist/\n');
  const tools = join(f.repo, 'node_modules/.bin');
  mkdirSync(tools, { recursive: true });
  const turbo = fileURLToPath(new URL('../node_modules/turbo/bin/turbo', import.meta.url));
  writeFileSync(
    join(tools, 'turbo'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(turbo)} "$@"\n`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(f.repo, 'package.json'),
    JSON.stringify({
      name: 'source-build-caller-fixture',
      private: true,
      packageManager: 'pnpm@10.33.3',
    })
  );
  writeFileSync(join(f.repo, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  writeFileSync(
    join(f.repo, 'pnpm-lock.yaml'),
    'lockfileVersion: "9.0"\nimporters:\n  .: {}\n  apps/nanocore: {}\n  packages/retrieval-kernel: {}\n'
  );
  const actualTasks = JSON.parse(
    readFileSync(new URL('../turbo.json', import.meta.url), 'utf8')
  ).tasks;
  writeFileSync(
    join(f.repo, 'turbo.json'),
    JSON.stringify({
      tasks: {
        '@openkit/nanocore#build:compiled': actualTasks['@openkit/nanocore#build:compiled'],
        '@openkit/nanocore#build': actualTasks['@openkit/nanocore#build'],
        build: { outputs: [] },
      },
    })
  );
  const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
  writeFileSync(
    join(nano, 'package.json'),
    JSON.stringify({
      name: '@openkit/nanocore',
      scripts: {
        build: 'node -e "process.exit(0)"',
        'build:compiled': `${JSON.stringify(process.execPath)} ${JSON.stringify(compiler)} -p tsconfig.json`,
      },
    })
  );
  writeFileSync(
    join(nano, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'es2022', module: 'esnext', types: [], outDir: 'dist' },
      files: ['input.ts'],
    })
  );
  writeFileSync(join(nano, 'input.ts'), 'export const sourceMarker: number = 42;\n');
  const forbidden = join(f.repo, '..', 'prerequisite-ran');
  writeFileSync(
    join(rust, 'package.json'),
    JSON.stringify({
      name: '@openkit/retrieval-kernel',
      scripts: {
        build: `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(forbidden)}, 'unexpected prerequisite rebuild'); process.exit(77);`)}`,
      },
    })
  );
  f.git('add', '.');
  f.git(
    '-c',
    'user.name=Build fixture',
    '-c',
    `user.email=${f.git('show', '-s', '--format=%ae', 'HEAD')}`,
    'commit',
    '-qm',
    'caller-owned prerequisite fixture'
  );
  assert.equal(buildSource({ repoRoot: f.repo, outputPath: f.output }), true);
  assert.equal(existsSync(forbidden), false);
  assert.match(readFileSync(join(nano, 'dist/input.js'), 'utf8'), /export const sourceMarker = 42/);
  assert.equal(JSON.parse(readFileSync(f.output, 'utf8')).sourceCommit, f.git('rev-parse', 'HEAD'));
  assert.throws(
    () =>
      execFileSync('pnpm', ['-w', 'exec', 'turbo', 'run', 'build', '--filter=@openkit/nanocore'], {
        cwd: f.repo,
        stdio: 'pipe',
      }),
    (error) => error.status === 77
  );
  assert.equal(existsSync(forbidden), true);
});

test('does not invent identity for a source tree without Git provenance', (t) => {
  const f = fixture(t, false);
  assert.equal(writeSourceBuildIdentity(f.repo, f.output), false);
  assert.equal(existsSync(f.output), false);
});
