#!/usr/bin/env node
/** Load baseline changes are explicit, provenance-bearing and tighten-only. No measurement refresh. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const baselinePath = 'apps/nanocore/src/test-support/main-loop-baseline.json';
const keys = ['maxMs', 'p50Ms', 'p999Ms', 'p99Ms'];

/** Reject absent/invalid values rather than recording them as a zero-cost baseline. */
export function validateBaseline(value) {
  if (
    !value ||
    Object.keys(value).sort().join() !== 'evidence,metrics,profile,schemaVersion,sourceCommit' ||
    value.schemaVersion !== 1 ||
    value.profile !== 'reference-1ws' ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
    typeof value.evidence !== 'string' ||
    !value.evidence.length ||
    !value.metrics ||
    Object.keys(value.metrics).sort().join() !== keys.join() ||
    Object.values(value.metrics).some(
      (n) => typeof n !== 'number' || !Number.isFinite(n) || n <= 0
    ) ||
    !(
      value.metrics.p50Ms <= value.metrics.p99Ms &&
      value.metrics.p99Ms <= value.metrics.p999Ms &&
      value.metrics.p999Ms <= value.metrics.maxMs
    )
  )
    throw Error('Invalid Main-loop baseline');
}

/** Each update needs new evidence and may not raise any retained metric. */
export function validateBaselineEvolution(before, after) {
  validateBaseline(before);
  validateBaseline(after);
  for (const key of keys)
    if (after.metrics[key] > before.metrics[key])
      throw Error(`Main-loop baseline cannot loosen: ${key}`);
  if (
    (keys.some((key) => before.metrics[key] !== after.metrics[key]) ||
      before.sourceCommit !== after.sourceCommit ||
      before.evidence !== after.evidence) &&
    (after.sourceCommit === before.sourceCommit ||
      after.evidence === before.evidence ||
      !keys.some((key) => after.metrics[key] < before.metrics[key]))
  )
    throw Error('Main-loop baseline update needs a tighter measurement and new provenance');
}

/** Inspect every baseline transition so a later tightening cannot hide an earlier loosening. */
export function validateBaselineHistory(root, current) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  if (git('rev-parse', '--is-shallow-repository') !== 'false')
    throw Error('Main-loop baseline requires complete Git history');
  let previous;
  for (const commit of git(
    'log',
    '--first-parent',
    '--reverse',
    '--format=%H',
    'HEAD',
    '--',
    baselinePath
  )
    .split('\n')
    .filter(Boolean)) {
    const next = JSON.parse(git('show', `${commit}:${baselinePath}`));
    validateBaseline(next);
    if (previous) validateBaselineEvolution(previous, next);
    previous = next;
  }
  validateBaseline(current);
  if (previous) validateBaselineEvolution(previous, current);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateBaselineHistory(process.cwd(), JSON.parse(readFileSync(baselinePath, 'utf8')));
  console.log('Main-loop baseline: PASS (explicit updates, tighten only)');
}
