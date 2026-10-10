/** Closed private inputs, secret-safe evidence, and single-shot effect receipts. */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

/** Fixed sequential runtime order from the frozen first-release checklist. */
export const RUNTIMES = ['codex', 'pi', 'opencode', 'deepseek'];
/** The exact denominator; every row is traversed even when its observation is absent. */
export const SCENARIOS = [
  'Deploy',
  ...RUNTIMES.flatMap((r) => ['A', 'B', 'C', 'D'].map((s) => `${r}.${s}`)),
  'Chat',
  'Task',
  'Goal',
  'External',
];
/** Hex SHA-256 identity for retained bytes and manifests. */
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Public content-digest representation used by Artifact and exact-intent owners. */
export const digest = (bytes) => `sha256:${sha(bytes)}`;
/** Canonical JSON preserves array order and sorts object keys; absent optional values stay absent. */
export function canonical(value) {
  function sort(v) {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .filter((k) => v[k] !== undefined)
          .map((k) => [k, sort(v[k])])
      );
    return v;
  }
  return JSON.stringify(sort(value));
}
const SECRET =
  /\b(?:gh[pousr]_|github_pat_|okt_|okw_|sk-)[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~+/-]{8,}=*|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|[a-z]+:\/\/[^\s/@]+:[^\s/@]+@/gi;
const secretKey =
  /^(authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|headerValue|capabilityCredential|inferenceCredential)$/i;

/** Retain authority-bearing objects while redacting scalar credential leaves and text. */
export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]');
    return value
      .replace(SECRET, '[redacted]')
      .replace(
        /((?:password|api[_-]?key|access[_-]?token|client_secret)\s*[:=]\s*)["']?[^\s,;"'}]+["']?/gi,
        '$1[redacted]'
      );
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        secretKey.test(k) && typeof v === 'string'
          ? '[redacted]'
          : /^(env|environment|headers)$/i.test(k) && v && typeof v === 'object'
            ? Object.fromEntries(Object.keys(v).map((n) => [n, '[redacted]']))
            : redact(v, secrets),
      ])
    );
  return value;
}
/** Refuse authority inputs that would need redaction rather than silently changing them. */
export function noSecrets(value) {
  if (JSON.stringify(redact(value)) !== JSON.stringify(value))
    throw Error('Secret-shaped input refused');
}
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

/** All deployment-specific inputs are declared; no command, verdict, or secret values are admitted. */
export function validateParams(p) {
  object(
    p,
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
      'task',
      'goal',
      'external',
      'bounds',
      'sequence',
      'authority',
      'knownReferences',
    ],
    'params'
  );
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
      'root',
      'archiveDirectory',
      'buildDirectory',
      'webDirectory',
      'container',
      'imageRepository',
      'environmentFile',
      'expectedContainer',
      'expectedImage',
      'configurationDigest',
      'bindingRevision',
      'bindingDigest',
      'nanoHostDigest',
      'workerDigest',
      'workerAgents',
      'componentCommits',
      'componentPaths',
      'protectedMetadataPaths',
      'payloadDigests',
      'diagnosticUnit',
      'minimumFreeBytes',
    ],
    'deployment'
  );
  const d = p.deployment;
  text(d.sshAlias, 'sshAlias', /^[a-z][a-z0-9-]{0,62}$/);
  text(d.machineId, 'machineId', /^[a-f0-9]{32}$/);
  for (const k of ['root', 'archiveDirectory', 'buildDirectory', 'webDirectory', 'environmentFile'])
    absolute(d[k], k);
  for (const k of ['container', 'imageRepository', 'diagnosticUnit'])
    text(d[k], k, /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
  for (const k of [
    'expectedContainer',
    'expectedImage',
    'configurationDigest',
    'bindingDigest',
    'nanoHostDigest',
    'workerDigest',
  ])
    text(d[k], k);
  for (const k of ['bindingRevision', 'minimumFreeBytes'])
    if (!Number.isSafeInteger(d[k]) || d[k] < 1) throw Error(`${k}: positive integer required`);
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
  strings(d.workerAgents, 'workerAgents');
  if (!d.workerAgents.length || new Set(d.workerAgents).size !== d.workerAgents.length)
    throw Error('Unique Worker Agents required');
  strings(d.protectedMetadataPaths, 'protectedMetadataPaths');
  for (const v of d.protectedMetadataPaths) absolute(v, 'protected path');
  if (!d.payloadDigests || Array.isArray(d.payloadDigests) || typeof d.payloadDigests !== 'object')
    throw Error('payloadDigests required');
  for (const [f, h] of Object.entries(d.payloadDigests)) {
    absolute(f, 'payload path');
    text(h, 'payload digest', /^[a-f0-9]{64}$/);
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
  if (
    [...RUNTIMES.map((r) => p.runtimes[r].agentId), p.task?.agentId].some(
      (id) => !d.workerAgents.includes(id)
    )
  )
    throw Error('workerAgents must include every runtime and Task Agent; also declare Goal Agents');
  object(p.issue, ['repository', 'number', 'title', 'state'], 'issue');
  object(
    p.task,
    [
      'repository',
      'issue',
      'base',
      'branch',
      'agentId',
      'allowedFiles',
      'expectedPatch',
      'decidingActorId',
    ],
    'task'
  );
  for (const v of [p.issue.repository, p.task.repository])
    text(v, 'repository', /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
  for (const n of [p.issue.number, p.task.issue])
    if (!Number.isInteger(n) || n < 1) throw Error('Issue number required');
  for (const k of ['title', 'state']) text(p.issue[k], k);
  for (const k of ['base', 'branch', 'agentId', 'expectedPatch', 'decidingActorId'])
    text(p.task[k], k);
  if (p.task.branch === p.task.base) throw Error('Task branch must differ from base');
  strings(p.task.allowedFiles, 'allowedFiles');
  object(p.goal, ['intent', 'filename', 'decidingActorId', 'requiredContent'], 'goal');
  for (const k of ['intent', 'filename', 'decidingActorId']) text(p.goal[k], k);
  strings(p.goal.requiredContent, 'requiredContent');
  object(p.external, ['executable', 'modelId', 'persona', 'goal', 'judgeFile'], 'external');
  absolute(p.external.executable, 'external executable');
  absolute(p.external.judgeFile, 'judgeFile');
  for (const k of ['modelId', 'persona', 'goal']) text(p.external[k], k);
  object(
    p.bounds,
    ['readAttempts', 'pollMs', 'observationMs', 'decisionMs', 'processMs'],
    'bounds'
  );
  for (const [k, v] of Object.entries(p.bounds))
    if (!Number.isInteger(v) || v < 1 || v > 3600000)
      throw Error(`${k}: bounded positive integer required`);
  if (p.bounds.readAttempts > 10) throw Error('readAttempts exceeds ten');
  object(p.sequence, ['priorCount', 'resetReason'], 'sequence');
  if (!Number.isInteger(p.sequence.priorCount) || p.sequence.priorCount < 0)
    throw Error('priorCount required');
  if (p.sequence.resetReason !== null) text(p.sequence.resetReason, 'resetReason');
  return p;
}
/** Decode retained JSON without transport, interpretation or recovery. */
export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
/** Write private redacted bytes exclusively unless the same owner updates its projection. */
export async function save(file, value, secrets = [], exclusive = true) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(redact(value, secrets), null, 2)}\n`, {
    flag: exclusive ? 'wx' : 'w',
    mode: 0o600,
  });
}

/** Open the credential through a non-following descriptor; never copy it to evidence. */
export async function credential(file) {
  const h = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat();
    if (!s.isFile() || (s.mode & 0o777) !== 0o600)
      throw Error('Credential file must be regular mode 0600');
    const v = (await h.readFile('utf8')).trim();
    if (!v) throw Error('Empty credential');
    return v;
  } finally {
    await h.close();
  }
}
/** Capture child output without a shell, including timeout and process exit. */
export function execute(executable, args, { input, cwd, env, timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(executable, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      timedOut = false;
    c.stdout.setEncoding('utf8');
    c.stderr.setEncoding('utf8');
    c.stdout.on('data', (v) => {
      stdout += v;
    });
    c.stderr.on('data', (v) => {
      stderr += v;
    });
    c.on('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      c.kill('SIGKILL');
    }, timeout);
    c.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout, stderr });
    });
    c.stdin.on('error', () => {});
    c.stdin.end(input);
  });
}
/** Create an exclusive receipt before an effect so ambiguity or crashes cannot replay it. */
export async function once(dir, name, input, effect, secrets = []) {
  noSecrets(input);
  const requestId = input.requestId ?? randomUUID();
  await save(path.join(dir, `${name}-intent.json`), {
    input,
    requestId,
    startedAt: new Date().toISOString(),
  });
  try {
    const result = await effect();
    await save(path.join(dir, `${name}-result.json`), result, secrets);
    return result;
  } catch (e) {
    await save(
      path.join(dir, `${name}-ambiguous.json`),
      { status: 'inspection-required', error: String(e) },
      secrets
    );
    throw e;
  }
}
/** Fail final retention if any saved bytes still contain a known or shaped credential. */
export async function scan(dir, secrets = []) {
  for (const file of await files(dir)) {
    const raw = await fs.readFile(path.join(dir, file), 'utf8');
    if (redact(raw, secrets) !== raw) throw Error(`Credential-shaped output in ${file}`);
  }
}
/** Enumerate retained evidence deterministically, refusing symlinks in new bundles. */
export async function files(dir) {
  const result = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw Error('Evidence symlink refused');
    const f = path.join(dir, item.name);
    if (item.isDirectory())
      for (const child of await files(f)) result.push(`${item.name}/${child}`);
    else if (item.isFile()) result.push(item.name);
    else throw Error('Non-regular evidence refused');
  }
  return result.sort();
}

/** Validate the owner's payload-bound preview without changing its retained confirmation bytes. */
export function workerPreparedMatches(v, target, configuration, imageDigest) {
  const ref = (r) =>
    r &&
    typeof r.artifactId === 'string' &&
    r.artifactId.length > 0 &&
    r.artifactVersion === 1 &&
    /^sha256:[a-f0-9]{64}$/.test(r.contentDigest);
  const layout = v?.image?.storageLayout,
    platform = v?.image?.platform,
    defaults = v?.image?.environmentDefaults;
  if (
    !layout ||
    !platform ||
    typeof platform.os !== 'string' ||
    !platform.os ||
    typeof platform.architecture !== 'string' ||
    !platform.architecture ||
    ![layout.uid, layout.gid].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    ![layout.family, layout.version].every(
      (value) => value === null || (typeof value === 'string' && value.length > 0)
    ) ||
    typeof layout.workingDirectory !== 'string' ||
    !layout.workingDirectory.startsWith('/') ||
    !Array.isArray(layout.targets) ||
    !layout.targets.length ||
    layout.targets.some((t) => typeof t.target !== 'string' || !t.target.startsWith('/')) ||
    (defaults &&
      (defaults.classification !== 'unadmitted' ||
        !/^sha256:[a-f0-9]{64}$/.test(defaults.defaultsDigest) ||
        !Array.isArray(defaults.names))) ||
    !/^sha256:[a-f0-9]{64}$/.test(configuration?.expectedRevision) ||
    !/^agents\/[A-Za-z0-9._-]+\.agent\.jsonc$/.test(configuration?.fileId) ||
    !Number.isFinite(Date.parse(v?.preparedAt))
  )
    return false;
  if (
    !v ||
    !ref(v.authoredCandidate) ||
    !ref(v.resolvedCandidate) ||
    canonical(v.target) !== canonical(target) ||
    canonical(v.configuration) !== canonical(configuration) ||
    v.image?.digest !== imageDigest ||
    v.replaceNow !== null ||
    !Array.isArray(v.affectedStorage) ||
    v.affectedStorage.length !== 0 ||
    typeof v.activationConfirmation !== 'string'
  )
    return false;
  let bound;
  try {
    const prefix = 'activate-worker-environment:';
    if (!v.activationConfirmation.startsWith(prefix)) return false;
    bound = JSON.parse(v.activationConfirmation.slice(prefix.length));
  } catch {
    return false;
  }
  return (
    canonical(bound) ===
    canonical({
      affectedStorage: [],
      imageDigest,
      defaultsDigest: v.image.environmentDefaults?.defaultsDigest ?? null,
      configuration,
      replaceNow: null,
      resolvedCandidate: v.resolvedCandidate,
      target,
    })
  );
}

/** Copy the exact prepared activation subject; the confirmation preview itself is never approval. */
export function workerActivationInput(v, requestId) {
  return {
    requestId,
    target: v.target,
    configuration: v.configuration,
    resolvedCandidate: v.resolvedCandidate,
    affectedStorage: v.affectedStorage,
    replaceNow: v.replaceNow,
    confirmation: v.activationConfirmation,
  };
}
