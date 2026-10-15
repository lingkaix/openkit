#!/usr/bin/env node
/** Partition complete deterministic owners without changing any owner's test selection or thresholds. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  coveredSuite,
  packageSuite,
  prepareCoverage,
  rootNodeInventory,
  rootSuite,
  testOwners,
} from './release-tests.mjs';

/** Give each coverage package one job; native suites, root tests and static/build checks stay distinct. */
export function shardPlan(root = process.cwd()) {
  const owners = testOwners(root);
  if (new Set(owners.map((o) => o.name)).size !== owners.length)
    throw Error('Duplicate deterministic test owner');
  return [
    { id: 'static', kind: 'static', owners: [] },
    { id: 'root', kind: 'root', owners: [] },
    { id: 'native', kind: 'native', owners: owners.filter((o) => !o.vitest).map((o) => o.name) },
    ...owners
      .filter((o) => o.vitest)
      .map((o) => ({
        id: o.name.replace('@openkit/', ''),
        kind: 'coverage',
        owners: [o.name],
      })),
  ];
}

/** A gate is complete only when every expected shard has exactly one successful observation. */
export function requireShardResults(results, expected = shardPlan().map((s) => s.id)) {
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
export function runShard(id, { root = process.cwd(), inventoryOnly = false } = {}) {
  const shard = shardPlan(root).find((s) => s.id === id);
  if (!shard) throw Error('Unknown L0-L2 shard');
  const owners = testOwners(root).filter((o) => shard.owners.includes(o.name));
  if (shard.kind === 'coverage') {
    prepareCoverage(owners, { root });
    const directory = resolve(root, 'temp/ci-shards');
    mkdirSync(directory, { recursive: true });
    for (const owner of owners)
      console.log(
        JSON.stringify(
          coveredSuite(owner, {
            inventoryOnly,
            reportFile: inventoryOnly ? undefined : join(directory, `${id}-execution.report`),
          })
        )
      );
  } else if (shard.kind === 'static') {
    if (inventoryOnly) throw Error('Inventory admission selects coverage shards only');
    for (const task of ['check:repo', 'lint', 'typecheck', 'build'])
      command(['pnpm', '-w', task], root);
  } else if (shard.kind === 'native') {
    if (inventoryOnly) throw Error('Inventory admission selects coverage shards only');
    // NanoHost's native protocol seam consumes the built NanoCore process.
    command(['pnpm', '--filter', '@openkit/nanocore...', 'build'], root);
    for (const owner of owners) packageSuite(owner, { root });
  } else {
    if (inventoryOnly) throw Error('Inventory admission selects coverage shards only');
    const files = rootSuite({ root });
    command(['python3', '-I', '-B', 'scripts/docker/app-update-helper.test.py'], root);
    return { files };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--matrix') {
      console.log(JSON.stringify({ include: shardPlan() }));
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
      throw Error('Usage: node scripts/ci-l0-l2.mjs --matrix | --run ID | --join DIRECTORY');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
