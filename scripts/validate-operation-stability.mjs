#!/usr/bin/env node
/** Declared semantic promises and permanent operation identities; not implementation proof. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const snapshotPath = 'scripts/operation-stability.json';
const classes = ['settled', 'release-coupled', 'experimental'];
const states = ['active', 'deprecated', 'retired'];

/** Stable JSON preserves array order and sorts object keys without locale collation. */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  return value;
}

/** Freeze declared meaning/authority, excluding transport status and the promotion marker. */
export function semanticDigest(definition) {
  const {
    stability: _stability,
    binding: _binding,
    successStatus: _status,
    successStatuses: _statuses,
    inputSchema,
    outputSchema,
    ...meaning
  } = definition;
  const value = {
    ...meaning,
    inputSchema: z.toJSONSchema(inputSchema, { io: 'input' }),
    outputSchema: z.toJSONSchema(outputSchema, { io: 'output' }),
  };
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

/** Closed snapshot shape prevents a typo from weakening an existing promise. */
export function validateSnapshot(snapshot) {
  if (
    !snapshot ||
    snapshot.schemaVersion !== 1 ||
    !snapshot.operations ||
    Array.isArray(snapshot.operations) ||
    typeof snapshot.operations !== 'object' ||
    Object.keys(snapshot).sort().join() !== 'operations,schemaVersion'
  )
    throw Error('Invalid operation stability snapshot');
  for (const [id, entry] of Object.entries(snapshot.operations)) {
    if (
      !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(id) ||
      !entry ||
      !classes.includes(entry.stability) ||
      !states.includes(entry.state) ||
      Object.keys(entry).some((key) => !['stability', 'state', 'digest'].includes(key)) ||
      (entry.stability === 'settled'
        ? !/^sha256:[a-f0-9]{64}$/.test(entry.digest)
        : entry.digest !== undefined)
    )
      throw Error(`Invalid operation stability entry: ${id}`);
  }
}

/** Historical identities remain present; settled definitions only deprecate or retire. */
export function validateEvolution(previous, current) {
  validateSnapshot(previous);
  validateSnapshot(current);
  for (const [id, before] of Object.entries(previous.operations)) {
    const after = current.operations[id];
    if (!after) throw Error(`Operation identity removed instead of retired: ${id}`);
    if (before.state === 'retired' && after.state !== 'retired')
      throw Error(`Retired operation id reused: ${id}`);
    if (before.stability === 'settled') {
      if (after.stability !== 'settled' || after.digest !== before.digest)
        throw Error(`Settled semantic contract changed: ${id}`);
      if (before.state === 'deprecated' && after.state === 'active')
        throw Error(`Settled deprecation reversed: ${id}`);
    }
  }
}

/** Retirement removes discovery/dispatch definitions, not the permanent identity receipt. */
export function validateRegistry(snapshot, registry) {
  validateSnapshot(snapshot);
  for (const [id, entry] of Object.entries(snapshot.operations)) {
    const definition = registry[id];
    if (entry.state === 'retired') {
      if (definition) throw Error(`Retired operation remains registered: ${id}`);
      continue;
    }
    if (!definition || definition.stability !== entry.stability)
      throw Error(`Operation stability differs from snapshot: ${id}`);
    if (entry.stability === 'settled' && semanticDigest(definition) !== entry.digest)
      throw Error(`Settled semantic contract differs from snapshot: ${id}`);
  }
  for (const [id, definition] of Object.entries(registry)) {
    if (!classes.includes(definition.stability) || !snapshot.operations[id])
      throw Error(`Missing operation stability declaration or snapshot: ${id}`);
  }
}

/** Compare every committed snapshot transition, including a rewritten digest/tombstone. */
export function validateHistory(root, current) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  if (git('rev-parse', '--is-shallow-repository') !== 'false')
    throw Error('Operation stability history requires a complete checkout (fetch-depth: 0)');
  const commits = git(
    'log',
    '--first-parent',
    '--reverse',
    '--format=%H',
    'HEAD',
    '--',
    snapshotPath
  )
    .split('\n')
    .filter(Boolean);
  let previous;
  for (const commit of commits) {
    const next = JSON.parse(git('show', `${commit}:${snapshotPath}`));
    validateSnapshot(next);
    if (previous) validateEvolution(previous, next);
    previous = next;
  }
  if (previous) validateEvolution(previous, current);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { OPERATION_REGISTRY } = await import('@openkit/app-api-schemas');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  validateHistory(process.cwd(), snapshot);
  validateRegistry(snapshot, OPERATION_REGISTRY);
  console.log(`Operation stability: ${Object.keys(snapshot.operations).length} identities checked`);
}
