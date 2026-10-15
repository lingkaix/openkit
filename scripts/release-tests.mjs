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
  { inventoryOnly = false, reportFile, spawn = spawnSync, run = guardedExecution } = {}
) {
  const cli = join(owner.cwd, 'node_modules/vitest/vitest.mjs');
  const collect = (coverage, filesOnly = false) => {
    const r = spawn(
      process.execPath,
      [
        cli,
        'list',
        '--json',
        '--maxWorkers=4',
        '--pool=threads',
        ...(coverage ? ['--coverage'] : []),
        ...(filesOnly ? ['--filesOnly'] : []),
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
    const expected = reportFile ? collect(true, true) : undefined;
    const errors = run({
      cwd: owner.cwd,
      command: [
        process.execPath,
        cli,
        'run',
        '--coverage',
        '--reporter=tap-flat',
        ...(reportFile ? ['--reporter=json', `--outputFile.json=${reportFile}`] : []),
      ],
    });
    if (errors.length) throw Error(`${owner.name}: ${errors.join('; ')}`);
    if (reportFile) {
      const report = JSON.parse(readFileSync(reportFile, 'utf8'));
      verifyExecutionInventory(expected, report);
    }
  }
  return {
    name: owner.name,
    cases: count,
    inventory: inventoryOnly ? 'equal' : reportFile ? 'execution files equal' : 'not collected',
    execution: inventoryOnly ? 'not run' : 'coverage passed',
  };
}
/** Compare collected case and file cardinality with the actual JSON reporter, including duplicate names. */
export function verifyExecutionInventory(expected, report) {
  if (report?.success !== true || !Array.isArray(report.testResults))
    throw Error('Test Strategy: missing successful execution report');
  const files = report.testResults.map((r) => r.name);
  const expectedFiles = [...new Set(expected.map((c) => c.file))].sort();
  if (JSON.stringify([...files].sort()) !== JSON.stringify(expectedFiles))
    throw Error('Test Strategy: a collected file did not execute exactly once');
  if (expected.every((c) => c.name === undefined)) return files.length;
  const executed = report.testResults.flatMap((r) =>
    r.assertionResults.map((a) => ({
      file: r.name,
      name: [...a.ancestorTitles, a.title].join(' > '),
    }))
  );
  return compareInventory(expected, executed);
}
/** Run distinct package tests under the same failure and skip admission as coverage and root suites. */
export function packageSuite(owner, { root = process.cwd(), run = guardedExecution } = {}) {
  const errors = run({ cwd: root, command: ['pnpm', '--filter', owner.name, 'test'] });
  if (errors.length) throw Error(`${owner.name}: ${errors.join('; ')}`);
}
/** Build the selected coverage owner's existing dependency graph before collection or execution. */
export function prepareCoverage(owners, { root = process.cwd() } = {}) {
  const command = (args) => {
    const r = spawnSync(args[0], args.slice(1), { cwd: root, stdio: 'inherit' });
    if (r.error || r.signal || r.status !== 0)
      throw Error(`Test Strategy: failed command ${args.join(' ')}`);
  };
  if (owners.length)
    command([
      'pnpm',
      'exec',
      'turbo',
      'run',
      'build',
      ...owners.map((o) => `--filter=${o.name}^...`),
    ]);
  if (owners.some((o) => o.name === '@openkit/nanocore'))
    command(['pnpm', '--filter', '@openkit/retrieval-kernel', 'build']);
}
/** Execute the root suite with its generated-CLI equality check and existing skip guard. */
export function rootSuite({ root = process.cwd() } = {}) {
  const command = (args) => {
    const r = spawnSync(args[0], args.slice(1), { cwd: root, stdio: 'inherit' });
    if (r.error || r.signal || r.status !== 0)
      throw Error(`Test Strategy: failed command ${args.join(' ')}`);
  };
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
        .sort()
        .map((n) => join(root, 'tests', n)),
    ],
  });
  if (errors.length) throw Error(`Root tests: ${errors.join('; ')}`);
}
/** Run distinct native/catalog tests and root tests without losing the previous unit gate's build checks. */
export function releaseTests({ root = process.cwd(), inventoryOnly = false } = {}) {
  const owners = testOwners(root);
  // Dependency builds were previously supplied by turbo test's ^build edges.
  prepareCoverage(
    owners.filter((o) => o.vitest),
    { root }
  );
  for (const owner of owners.filter((o) => o.vitest))
    console.log(JSON.stringify(coveredSuite(owner, { inventoryOnly })));
  if (inventoryOnly) return;
  for (const owner of owners.filter((o) => !o.vitest)) packageSuite(owner, { root });
  rootSuite({ root });
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
