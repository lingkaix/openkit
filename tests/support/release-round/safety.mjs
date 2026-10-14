/** Qualification-owned matrix, sentence, Artifact digest and closed parameter admission. */
import path from 'node:path';
import { noSecrets, sha } from '../../../scripts/release-safety.mjs';

/** Fixed runtime matrix membership from the frozen first-release checklist. */
export const RUNTIMES = ['codex', 'pi', 'opencode', 'deepseek'];
/** The exact denominator; every qualification row is traversed even when its observation is absent. */
/** Benign public sentence binds case A to this attempt and runtime without changing file fixtures. */
export const replySentence = (p, runtime) => `OpenKit connectivity check ${p.roundId} ${runtime}`;
/** The exact qualification denominator. */
export const SCENARIOS = RUNTIMES.flatMap((r) => ['A', 'B', 'C', 'D'].map((s) => `${r}.${s}`));
/** Public Artifact digest for qualification-owned byte comparisons. */
export const digest = (bytes) => `sha256:${sha(bytes)}`;
function object(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error(`${name}: object required`);
  for (const k of Object.keys(value))
    if (!keys.includes(k)) throw Error(`${name}: unknown key ${k}`);
  for (const k of keys) if (!(k in value)) throw Error(`${name}: missing ${k}`);
}
function text(value, name, pattern = /.+/) {
  if (
    typeof value !== 'string' ||
    !value.length ||
    [...value].some((c) => c.charCodeAt(0) < 32) ||
    !pattern.test(value)
  )
    throw Error(`${name}: invalid string`);
}
function strings(values, name) {
  if (!Array.isArray(values)) throw Error(`${name}: array required`);
  for (const v of values) text(v, name);
}
function absolute(value, name) {
  text(value, name);
  if (!path.isAbsolute(value) || /[\n\r]/.test(value))
    throw Error(`${name}: absolute path required`);
}

/** Declare qualification inputs; refuse commands, verdicts and secrets. */
export function validateParams(p) {
  object(
    Object.fromEntries(Object.entries(p).filter(([key]) => key !== 'releaseTag')),
    [
      'roundId',
      'candidateCommit',
      'checklistBlob',
      'scenarioRevision',
      'evidenceAlias',
      'workspaceId',
      'protectedIds',
      'cli',
      'deployment',
      'runtimes',
      'issue',
      'bounds',
      'authority',
      'knownReferences',
    ],
    'params'
  );
  if (p.releaseTag !== undefined) text(p.releaseTag, 'releaseTag', /^v0\.1\.0-rc\.[1-9][0-9]*$/);
  noSecrets(p);
  text(p.roundId, 'roundId', /^[a-z0-9][a-z0-9-]{0,62}$/);
  text(p.candidateCommit, 'candidateCommit', /^[a-f0-9]{40}$/);
  text(p.checklistBlob, 'checklistBlob', /^[a-f0-9]{40}$/);
  text(p.scenarioRevision, 'scenarioRevision');
  text(p.evidenceAlias, 'evidenceAlias', /^[a-z0-9-]+$/);
  text(p.workspaceId, 'workspaceId');
  strings(p.protectedIds, 'protectedIds');
  strings(p.authority, 'authority');
  strings(p.knownReferences, 'knownReferences');
  if (!p.authority.length) throw Error('Effect-specific authority references required');
  object(p.cli, ['executable', 'credentialFile', 'origin'], 'cli');
  absolute(p.cli.executable, 'cli.executable');
  absolute(p.cli.credentialFile, 'cli.credentialFile');
  const origin = new URL(p.cli.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw Error('HTTPS public origin required');
  object(
    p.deployment,
    [
      'sshAlias',
      'machineId',
      'container',
      'imageRepository',
      'configurationDigest',
      'nanoHostDigest',
      'workerDigest',
      'appImage',
      'webIdentity',
      'componentCommits',
      'componentPaths',
      'diagnosticUnit',
    ],
    'deployment'
  );
  const d = p.deployment;
  text(d.sshAlias, 'sshAlias', /^[a-z][a-z0-9-]{0,62}$/);
  if (d.sshAlias === 'a2') throw Error('Production a2 is excluded from release automation');
  text(d.machineId, 'machineId', /^[a-f0-9]{32}$/);
  for (const k of ['container', 'imageRepository', 'diagnosticUnit'])
    text(d[k], k, /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
  // Copy appImage and webIdentity unchanged; do not turn an OCI manifest digest into a local image id or the reverse.
  for (const k of [
    'configurationDigest',
    'nanoHostDigest',
    'workerDigest',
    'appImage',
    'webIdentity',
  ])
    text(d[k], k);
  object(d.componentCommits, ['nanoHost', 'worker'], 'componentCommits');
  object(d.componentPaths, ['nanoHost', 'worker'], 'componentPaths');
  for (const k of ['nanoHost', 'worker']) {
    text(d.componentCommits[k], k, /^[a-f0-9]{40}$/);
    strings(d.componentPaths[k], k);
    if (
      !d.componentPaths[k].length ||
      d.componentPaths[k].some((v) => v.startsWith('/') || v.split('/').includes('..'))
    )
      throw Error('Component input paths required');
  }
  object(p.runtimes, RUNTIMES, 'runtimes');
  for (const r of RUNTIMES) {
    object(
      p.runtimes[r],
      ['agentId', 'profileId', 'modelId', 'configurationVersion', 'marker', 'filename'],
      'runtime'
    );
    const v = p.runtimes[r];
    for (const k of ['agentId', 'profileId', 'modelId', 'marker']) text(v[k], k);
    text(v.filename, 'filename', /^[a-zA-Z0-9._-]+$/);
    if (!Number.isInteger(v.configurationVersion) || v.configurationVersion < 1)
      throw Error('configurationVersion required');
  }
  object(p.issue, ['repository', 'number', 'title', 'state'], 'issue');
  text(p.issue.repository, 'repository', /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
  if (!Number.isInteger(p.issue.number) || p.issue.number < 1) throw Error('Issue number required');
  for (const k of ['title', 'state']) text(p.issue[k], k);
  object(p.bounds, ['readAttempts', 'pollMs', 'observationMs', 'processMs'], 'bounds');
  for (const [k, v] of Object.entries(p.bounds))
    if (!Number.isInteger(v) || v < 1 || v > 3600000)
      throw Error(`${k}: bounded positive integer required`);
  if (p.bounds.readAttempts > 10) throw Error('readAttempts exceeds ten');
  return p;
}
