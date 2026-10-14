#!/usr/bin/env node
/** Execute deterministic suites once; inventory-only proves collection equivalence before recipe admission. */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Reuse the existing skip guard while streaming deciding test output to CI. */
function guardedExecution({ cwd, command }) {
  const guard = new URL('./validate-test-governance.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [guard.pathname, '--run', '--', ...command], {
    cwd,
    stdio: 'inherit',
  });
  return result.error || result.signal || result.status !== 0
    ? [`Guarded test execution failed: ${result.error?.message ?? result.signal ?? result.status}`]
    : [];
}

/** Derive owners from existing workspace scripts; refuse an unaccounted coverage suite. */
export function testOwners(root) {
  return ['apps', 'packages'].flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        let pkg;
        try {
          pkg = JSON.parse(readFileSync(join(root, group, entry.name, 'package.json'), 'utf8'));
        } catch (error) {
          if (error.code === 'ENOENT') return [];
          throw error;
        }
        if (!pkg.scripts?.test) return [];
        const unit = pkg.scripts.test,
          coverage = pkg.scripts['test:coverage'];
        if (coverage || unit.startsWith('vitest ')) {
          if (unit !== 'vitest run --reporter=tap-flat' || coverage !== 'vitest run --coverage')
            throw Error(`Test Strategy: unproved overlapping commands for ${pkg.name}`);
        }
        return [{ name: pkg.name, cwd: join(root, group, entry.name), vitest: Boolean(coverage) }];
      })
  );
}
/** Compare complete collected case names and file identities, preserving duplicate cardinality. */
export function compareInventory(unit, covered) {
  const normalize = (list) => {
    if (
      !Array.isArray(list) ||
      !list.length ||
      list.some((v) => typeof v.name !== 'string' || typeof v.file !== 'string')
    )
      throw Error('Test Strategy: missing collected inventory');
    return list.map(({ name, file }) => JSON.stringify([file, name])).sort();
  };
  const a = normalize(unit),
    b = normalize(covered);
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw Error('Test Strategy: coverage collected a different test inventory');
  return a.length;
}
/** Either prove inventory admission or execute the admitted coverage recipe with the existing skip guard. */
export function coveredSuite(
  owner,
  { inventoryOnly = false, spawn = spawnSync, run = guardedExecution } = {}
) {
  const cli = join(owner.cwd, 'node_modules/vitest/vitest.mjs');
  const collect = (coverage) => {
    const r = spawn(
      process.execPath,
      [
        cli,
        'list',
        '--json',
        '--maxWorkers=4',
        '--pool=threads',
        ...(coverage ? ['--coverage'] : []),
      ],
      { cwd: owner.cwd, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 }
    );
    if (r.error || r.signal || r.status !== 0)
      throw Error(
        `Test Strategy: collection failed for ${owner.name}: ${r.error?.message ?? r.signal ?? r.stderr}`
      );
    return JSON.parse(r.stdout);
  };
  const count = inventoryOnly ? compareInventory(collect(false), collect(true)) : undefined;
  if (!inventoryOnly) {
    const errors = run({
      cwd: owner.cwd,
      command: [process.execPath, cli, 'run', '--coverage', '--reporter=tap-flat'],
    });
    if (errors.length) throw Error(`${owner.name}: ${errors.join('; ')}`);
  }
  return {
    name: owner.name,
    cases: count,
    inventory: inventoryOnly ? 'equal' : 'not collected',
    execution: inventoryOnly ? 'not run' : 'coverage passed',
  };
}
/** Run distinct native/catalog tests and root tests without losing the previous unit gate's build checks. */
export function releaseTests({ root = process.cwd(), inventoryOnly = false } = {}) {
  const owners = testOwners(root);
  const command = (args) => {
    const r = spawnSync(args[0], args.slice(1), { cwd: root, stdio: 'inherit' });
    if (r.error || r.signal || r.status !== 0)
      throw Error(`Test Strategy: failed command ${args.join(' ')}`);
  };
  // Dependency builds were previously supplied by turbo test's ^build edges.
  command([
    'pnpm',
    'exec',
    'turbo',
    'run',
    'build',
    ...owners.filter((o) => o.vitest).map((o) => `--filter=${o.name}^...`),
  ]);
  for (const owner of owners.filter((o) => o.vitest))
    console.log(JSON.stringify(coveredSuite(owner, { inventoryOnly })));
  if (inventoryOnly) return;
  for (const owner of owners.filter((o) => !o.vitest))
    command(['pnpm', '--filter', owner.name, 'test']);
  command(['pnpm', '--filter', '@openkit/core-client...', 'build']);
  command([
    'pnpm',
    'exec',
    'esbuild',
    'skills/openkit-cli.mjs',
    '--bundle',
    '--platform=node',
    '--target=node24',
    '--format=cjs',
    '--minify',
    '--outfile=skills/openkit-ops/scripts/openkit',
  ]);
  command(['git', 'diff', '--exit-code', '--', 'skills/openkit-ops/scripts/openkit']);
  const errors = guardedExecution({
    cwd: root,
    command: [
      process.execPath,
      '--test',
      ...readdirSync(join(root, 'tests'))
        .filter((n) => n.endsWith('.test.mjs'))
        .map((n) => join(root, 'tests', n)),
    ],
  });
  if (errors.length) throw Error(`Root tests: ${errors.join('; ')}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).some((a) => a !== '--inventory-only'))
      throw Error('Usage: node scripts/release-tests.mjs [--inventory-only]');
    releaseTests({ inventoryOnly: process.argv.includes('--inventory-only') });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
