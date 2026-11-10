import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import {
  semanticDigest,
  validateEvolution,
  validateHistory,
  validateRegistry,
  validateSnapshot,
} from '../scripts/validate-operation-stability.mjs';

const definition = {
  stability: 'settled',
  binding: 'json',
  successStatus: 200,
  description: 'Read one admitted record without effects.',
  mutating: false,
  credentials: ['user-bearer'],
  scope: { kind: 'user' },
  target: { kind: 'user' },
  policyOperation: 'workspace.read',
  inputSchema: z.object({ id: z.string() }).strict(),
  outputSchema: z.object({ value: z.string() }).strict(),
};
const digest = semanticDigest(definition);
const settled = (state = 'active') => ({ stability: 'settled', state, digest });
const snapshot = (operations) => ({ schemaVersion: 1, operations });

test('settled digest freezes schema, meaning, effects and authority, excluding transport status', () => {
  for (const amendment of [
    { inputSchema: z.object({ id: z.number() }).strict() },
    { outputSchema: z.object({ value: z.number() }).strict() },
    { description: 'Delete the admitted record.' },
    { mutating: true },
    { credentials: ['deployment-administrator'] },
    { scope: { kind: 'server' } },
    { policyOperation: 'workspace.write' },
    { insertionPoints: { stages: ['commit'] } },
  ])
    assert.notEqual(semanticDigest({ ...definition, ...amendment }), digest);
  assert.equal(semanticDigest({ ...definition, binding: 'streaming', successStatus: 201 }), digest);
  assert.equal(semanticDigest(Object.fromEntries(Object.entries(definition).reverse())), digest);
});

test('settled additions, deprecation with unchanged invocation, and retirement are allowed', () => {
  const initial = snapshot({ 'work.read': settled() });
  const deprecated = snapshot({ 'work.read': settled('deprecated'), 'work.next': settled() });
  validateEvolution(initial, deprecated);
  validateRegistry(deprecated, { 'work.read': definition, 'work.next': definition });
  const retired = snapshot({ 'work.read': settled('retired'), 'work.next': settled() });
  validateEvolution(deprecated, retired);
  validateRegistry(retired, { 'work.next': definition });
});

test('settled digest replacement, demotion, removal and deprecation reversal refuse', () => {
  for (const operations of [
    { 'work.read': { ...settled(), digest: `sha256:${'0'.repeat(64)}` } },
    { 'work.read': { stability: 'release-coupled', state: 'active' } },
    {},
  ])
    assert.throws(() =>
      validateEvolution(snapshot({ 'work.read': settled() }), snapshot(operations))
    );
  assert.throws(() =>
    validateEvolution(
      snapshot({ 'work.read': settled('deprecated') }),
      snapshot({ 'work.read': settled() })
    )
  );
});

test('no retired identity is reused, including an operation that never settled', () => {
  for (const entry of [settled('retired'), { stability: 'release-coupled', state: 'retired' }]) {
    assert.throws(
      () =>
        validateEvolution(
          snapshot({ 'work.read': entry }),
          snapshot({ 'work.read': { ...entry, state: 'active' } })
        ),
      /reused/
    );
    assert.throws(
      () => validateRegistry(snapshot({ 'work.read': entry }), { 'work.read': definition }),
      /remains registered/
    );
  }
});

test('missing or invalid metadata and an absent active operation refuse', () => {
  for (const entry of [
    { ...settled(), stability: 'stable' },
    { ...settled(), state: 'blocked' },
    { ...settled(), digest: null },
    { ...settled(), typo: true },
  ])
    assert.throws(() => validateSnapshot(snapshot({ 'work.read': entry })));
  assert.throws(() => validateRegistry(snapshot({ 'work.read': settled() }), {}));
  assert.throws(() => validateRegistry(snapshot({}), { 'work.read': definition }));
  assert.throws(() =>
    validateRegistry(snapshot({ 'work.read': settled() }), {
      'work.read': { ...definition, mutating: true },
    })
  );
});

test('the real Git history rejects rewritten settled digests and forgotten tombstones', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-operation-stability-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  try {
    git('init', '--initial-branch=main');
    mkdirSync(join(root, 'scripts'));
    const commit = (value) => {
      writeFileSync(join(root, 'scripts/operation-stability.json'), JSON.stringify(value));
      git('add', '.');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-m',
        'fixture'
      );
    };
    const initial = snapshot({ 'work.read': settled() });
    commit(initial);
    validateHistory(root, initial);
    const altered = snapshot({ 'work.read': { ...settled(), digest: `sha256:${'0'.repeat(64)}` } });
    commit(altered);
    assert.throws(() => validateHistory(root, altered), /contract changed/);
    // Replacing the current snapshot with the original cannot erase the bad committed transition.
    assert.throws(() => validateHistory(root, initial), /contract changed/);
    git('reset', '--hard', 'HEAD~1');
    const retired = snapshot({ 'work.read': settled('retired') });
    commit(retired);
    assert.throws(() => validateHistory(root, snapshot({})), /identity removed/);
    assert.throws(() => validateHistory(root, initial), /reused/);
    validateHistory(root, retired);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
