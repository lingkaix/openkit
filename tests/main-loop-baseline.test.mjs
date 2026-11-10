import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  baselinePath,
  validateBaseline,
  validateBaselineEvolution,
  validateBaselineHistory,
} from '../scripts/validate-main-loop-baseline.mjs';

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const tighter = () => ({
  ...baseline,
  sourceCommit: 'a'.repeat(40),
  evidence: 'explicit-new-measurement.json',
  metrics: { ...baseline.metrics, p99Ms: 16 },
});

test('the approved baseline is valid and an explicit tighter update is allowed', () => {
  validateBaseline(baseline);
  validateBaselineEvolution(baseline, baseline);
  validateBaselineEvolution(baseline, tighter());
});

test('no metric can loosen, even with a new commit and evidence', () => {
  for (const key of Object.keys(baseline.metrics)) {
    const next = tighter();
    next.metrics[key] = baseline.metrics[key] + 1;
    assert.throws(() => validateBaselineEvolution(baseline, next));
  }
});

test('missing, invalid and unordered observations do not become baseline numbers', () => {
  for (const value of [null, -1, NaN, Infinity, 0])
    assert.throws(() =>
      validateBaseline({ ...baseline, metrics: { ...baseline.metrics, p99Ms: value } })
    );
  assert.throws(() => validateBaseline({ ...baseline, metrics: { p99Ms: 1 } }));
});

test('an update cannot reuse old provenance or change provenance without tightening', () => {
  for (const next of [
    { ...tighter(), sourceCommit: baseline.sourceCommit },
    { ...tighter(), evidence: baseline.evidence },
    { ...tighter(), metrics: baseline.metrics },
  ])
    assert.throws(() => validateBaselineEvolution(baseline, next));
});

test('history detects a committed loosen-then-tighten attempt', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-baseline-'));
  const git = (...args) =>
    execFileSync(
      'git',
      ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args],
      { stdio: 'pipe' }
    );
  try {
    git('init', '-q');
    mkdirSync(dirname(join(root, baselinePath)), { recursive: true });
    const commit = (value) => {
      writeFileSync(join(root, baselinePath), JSON.stringify(value));
      git('add', '.');
      git('commit', '-qm', 'test: baseline transition');
    };
    commit(baseline);
    const loose = tighter();
    loose.metrics.maxMs *= 2;
    commit(loose);
    commit(tighter());
    assert.throws(() => validateBaselineHistory(root, tighter()), /cannot loosen/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
