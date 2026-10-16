#!/usr/bin/env node
/** Partition complete deterministic owners without changing any owner's test selection or thresholds. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as suites from './release-tests.mjs';
import {
  coveredSuite,
  packageSuite,
  prepareCoverage,
  rootNodeInventory,
  rootSuite,
  testOwners,
} from './release-tests.mjs';

/** Keep task owners independent and partition only the measured slow coverage suites. */
export function shardPlan(root = process.cwd()) {
  const owners = testOwners(root);
  if (new Set(owners.map((o) => o.name)).size !== owners.length)
    throw Error('Duplicate deterministic test owner');
  return [
    ...['check:repo', 'lint', 'typecheck', 'build'].map((task) => ({
      id: `static-${task.replace(':', '-')}`,
      kind: 'static',
      owners: [],
      task,
    })),
    { id: 'root', kind: 'root', owners: [] },
    ...owners
      .filter((o) => !o.vitest)
      .map((owner) => ({
        id: `native-${owner.name.replace('@openkit/', '')}`,
        kind: 'native',
        owners: [owner.name],
      })),
    ...owners
      .filter((o) => o.vitest)
      .flatMap((owner) => {
        const id = owner.name.replace('@openkit/', '');
        if (['nanocore', 'worker-shim'].includes(id))
          return Array.from({ length: 8 }, (_, index) => ({
            id: `${id}-${index + 1}`,
            kind: 'coverage',
            owners: [owner.name],
            partition: { index: index + 1, count: 8 },
          }));
        return [{ id, kind: 'coverage', owners: [owner.name] }];
      }),
  ];
}

/** Derive one whole-owner coverage merge for each partitioned suite. */
export function coveragePlan(root = process.cwd()) {
  return shardPlan(root)
    .filter((s) => s.partition?.index === 1)
    .map((s) => ({ id: s.owners[0].replace('@openkit/', ''), owners: s.owners }));
}

/** A gate is complete only when every expected shard has exactly one successful observation. */
export function requireShardResults(
  results,
  expected = [...shardPlan().map((s) => s.id), ...coveragePlan().map((s) => `${s.id}-coverage`)]
) {
  if (
    !Array.isArray(results) ||
    results.length !== expected.length ||
    new Set(expected).size !== expected.length ||
    expected.some(
      (id) => results.filter((r) => r.id === id && r.conclusion === 'success').length !== 1
    )
  )
    throw Error('Incomplete successful L0-L2 shard set');
  if (expected.includes('root')) {
    const files = results.find((r) => r.id === 'root').files;
    if (
      !Array.isArray(files) ||
      JSON.stringify(files.slice().sort()) !== JSON.stringify(rootNodeInventory().files)
    )
      throw Error('Incomplete exactly-once root and script Node test inventory');
  }
}

/** Preserve command errors and signals while exposing deciding output. */
function command(args, root) {
  const result = spawnSync(args[0], args.slice(1), { cwd: root, stdio: 'inherit' });
  if (result.error || result.signal || result.status !== 0)
    throw Error(`L0-L2 shard command failed: ${args[0]}`);
}

/** Execute one complete shard; coverage uses the already admitted unchanged package recipe. */
export function runShard(
  id,
  { root = process.cwd(), inventoryOnly = false, execute = command, runPackage = packageSuite } = {}
) {
  const shard = shardPlan(root).find((s) => s.id === id);
  if (!shard) throw Error('Unknown L0-L2 shard');
  const owners = testOwners(root).filter((o) => shard.owners.includes(o.name));
  if (shard.kind === 'coverage') {
    prepareCoverage(owners, { root });
    const directory = resolve(
      root,
      'temp/ci-shards',
      ...(shard.partition ? [owners[0].name.replace('@openkit/', '')] : [])
    );
    mkdirSync(directory, { recursive: true });
    if (shard.partition) mkdirSync(join(directory, 'blobs'), { recursive: true });
    const executions = owners.map((owner) =>
      coveredSuite(owner, {
        inventoryOnly,
        partition: shard.partition,
        reportFile: inventoryOnly ? undefined : join(directory, `${id}-execution.report`),
        blobFile:
          !inventoryOnly && shard.partition ? join(directory, 'blobs', `${id}.json`) : undefined,
      })
    );
    for (const execution of executions) console.log(JSON.stringify(execution));
    return {
      owners: shard.owners,
      ...(shard.partition ? { partition: shard.partition } : {}),
      executions,
    };
  } else if (shard.kind === 'static') {
    if (inventoryOnly) throw Error('Inventory admission selects coverage shards only');
    execute(['pnpm', '-w', shard.task], root);
  } else if (shard.kind === 'native') {
    if (inventoryOnly) throw Error('Inventory admission selects coverage shards only');
    // Only NanoHost's native protocol seam consumes the built NanoCore process.
    if (shard.owners.includes('@openkit/nanohost'))
      execute(['pnpm', '--filter', '@openkit/nanocore...', 'build'], root);
    for (const owner of owners) runPackage(owner, { root });
  } else {
    if (inventoryOnly) throw Error('Inventory admission selects coverage shards only');
    const files = rootSuite({ root });
    execute(['python3', '-I', '-B', 'scripts/docker/app-update-helper.test.py'], root);
    return { files };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--matrix') {
      console.log(JSON.stringify({ include: shardPlan() }));
    } else if (args.length === 1 && args[0] === '--coverage-matrix') {
      console.log(JSON.stringify({ include: coveragePlan() }));
    } else if (args[0] === '--merge-coverage' && args.length === 2) {
      const merge = coveragePlan().find((s) => s.id === args[1]);
      if (!merge) throw Error('Unknown L0-L2 coverage merge');
      const owner = testOwners(process.cwd()).find((o) => merge.owners.includes(o.name));
      const directory = resolve('temp/ci-shards', merge.id);
      const execution = suites.mergeCoveredSuite(owner, {
        directory,
        reportFile: join(directory, `${merge.id}-merged-execution.report`),
        count: 8,
      });
      writeFileSync(
        resolve('temp/ci-shards', `${merge.id}-coverage.json`),
        JSON.stringify({ id: `${merge.id}-coverage`, conclusion: 'success', execution })
      );
    } else if (args[0] === '--join' && args.length === 2) {
      const files = readdirSync(args[1]).filter((f) => f.endsWith('.json'));
      requireShardResults(files.map((f) => JSON.parse(readFileSync(join(args[1], f), 'utf8'))));
    } else if (args[0] === '--run' && args.length === 2) {
      const details = runShard(args[1]);
      const directory = resolve('temp/ci-shards');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, `${args[1]}.json`),
        JSON.stringify({ id: args[1], conclusion: 'success', ...details })
      );
    } else {
      throw Error(
        'Usage: node scripts/ci-l0-l2.mjs --matrix | --coverage-matrix | --run ID | --merge-coverage ID | --join DIRECTORY'
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
