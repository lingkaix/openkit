// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const setup = join(root, 'tests/support/vitest-global-setup.mjs');
const require = createRequire(join(root, 'apps/nanocore/package.json'));
const vitest = dirname(require.resolve('vitest/package.json'));

test('every Vitest configuration starts with the shared temporary-directory setup', () => {
  const configs = ['apps/web/vite.config.ts'];
  for (const name of readdirSync(join(root, 'apps/nanocore')))
    if (/^vitest.*\.config\.ts$/.test(name)) configs.push(`apps/nanocore/${name}`);
  for (const directory of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const manifest = join(root, 'packages', directory.name, 'package.json');
    if (!existsSync(manifest)) continue;
    const { scripts } = JSON.parse(readFileSync(manifest, 'utf8'));
    if (/\bvitest\b/.test(scripts?.test ?? ''))
      configs.push(`packages/${directory.name}/vitest.config.ts`);
  }
  // Vite plugins can retain background workers after config import. Bound that probe to its own process.
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    import { join } from 'node:path';
    for (const config of ${JSON.stringify(configs)}) {
      const { default: resolved } = await import(pathToFileURL(join(${JSON.stringify(root)}, config)).href);
      assert.equal(resolved.test.globalSetup[0], ${JSON.stringify(setup)}, config);
    }
    process.exit(0);
  `,
    ],
    { encoding: 'utf8', timeout: 30_000 }
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const projects of [false, true]) {
  for (const failing of [false, true]) {
    test(`Vitest ${projects ? 'projects' : 'suite'} removes worker temporary files after ${failing ? 'failure' : 'success'}`, (t) => {
      const fixture = mkdtempSync(join(tmpdir(), 'vitest-tmp-regression-'));
      t.after(() => rmSync(fixture, { recursive: true, force: true }));
      const parent = join(fixture, 'tmp');
      mkdirSync(parent);
      const observed = join(fixture, 'observed.json');
      const vitestImport = pathToFileURL(join(vitest, 'dist/index.js')).href;
      writeFileSync(
        join(fixture, 'subject.test.js'),
        `
      import { test, expect } from ${JSON.stringify(vitestImport)};
      import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      test('real worker temporary directory', () => {
        const run = tmpdir();
        const leaked = mkdtempSync(join(run, 'deliberate-fixture-leak-'));
        writeFileSync(join(leaked, 'data'), 'fixture');
        appendFileSync(${JSON.stringify(observed)}, JSON.stringify({ run, leaked }) + '\\n');
        expect(run).not.toBe(${JSON.stringify(parent)});
        expect(run.startsWith(${JSON.stringify(parent + '/')})).toBe(true);
        ${failing ? "throw new Error('deliberate subject failure');" : ''}
      });
    `
      );
      writeFileSync(
        join(fixture, 'vitest.config.mjs'),
        `export default { test: {
      globalSetup: [${JSON.stringify(setup)}], pool: 'forks',
      include: ['subject.test.js'], maxWorkers: 1, fileParallelism: false,
      ${projects ? "projects: [{ test: { name: 'first', include: ['subject.test.js'] } }, { test: { name: 'second', include: ['subject.test.js'] } }]," : ''}
    } };`
      );
      const result = spawnSync(process.execPath, [join(vitest, 'vitest.mjs'), 'run'], {
        cwd: fixture,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, TMPDIR: parent, TMP: parent, TEMP: parent },
      });
      assert.equal(result.status, failing ? 1 : 0, result.stdout + result.stderr);
      assert.ok(existsSync(observed), 'the real worker must execute before cleanup is assessed');
      const records = readFileSync(observed, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(records.length, projects ? 2 : 1);
      assert.equal(
        new Set(records.map(({ run }) => run)).size,
        1,
        'projects share one invocation directory'
      );
      for (const { run, leaked } of records) {
        assert.equal(existsSync(run), false);
        assert.equal(existsSync(leaked), false);
      }
      assert.deepEqual(
        readdirSync(parent),
        [],
        'the completed run must leave no entries in its parent'
      );
    });
  }
}
