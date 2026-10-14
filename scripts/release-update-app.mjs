#!/usr/bin/env node
/** Bounded App update through existing public operations; later component effects retain their owners. */
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReleaseManifest } from './release-record.mjs';
import { canonical, noSecrets, once, save } from './release-safety.mjs';

const predicates = [
  'imageMatch',
  'sourceMatch',
  'acceptingProductWork',
  'noBlockingReadiness',
  'newBoot',
  'retainedAuthRead',
  'nanohostReady',
  'helperReachable',
  'webAssets',
];
const counts = [
  'runningTurns',
  'pendingTurns',
  'queuedAdmissions',
  'openAttempts',
  'closingAttempts',
  'inFlightCommands',
];
/** Keep a violated App-update invariant local with its owning reason. */
function requireFact(holds, name) {
  if (!holds) throw Error(`App Update Delivery: ${name}`);
}
/** Reject absent target/authority/assessment before any public operation or credential read. */
export function validateUpdate(target, p, deployment) {
  const url = new URL(target);
  requireFact(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash,
    'explicit HTTPS target required'
  );
  requireFact(
    url.hostname !== 'a2' &&
      p?.grant?.target === target &&
      p.grant.environment === 'staging-test' &&
      p.grant.revoked === false &&
      p.grant.reference,
    'target outside bounded deployment grant'
  );
  requireFact(
    deployment?.sshAlias === 'a1' &&
      deployment.origin === url.origin &&
      /^[a-f0-9]{32}$/.test(deployment.machineId ?? '') &&
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(deployment.container ?? '') &&
      typeof deployment.reference === 'string' &&
      deployment.reference.length > 0 &&
      p.grant.deploymentReference === deployment.reference,
    'target differs from retained a1 deployment binding'
  );
  requireFact(
    p.grant.operations?.includes('app-update') && p.grant.maintenance === 'idle-only',
    'App maintenance authority required'
  );
  noSecrets(p);
  const m = p.manifest;
  requireFact(m?.schemaVersion === 1, 'unknown release manifest core');
  createReleaseManifest({
    repository: m.repository,
    tag: m.tag,
    sha: m.sourceCommit,
    images: m.images.map((i) => ({
      ...i,
      prerelease: true,
      tags: [m.tag, m.tag.slice(1), `sha-${m.sourceCommit.slice(0, 12)}`],
    })),
    checksums: m.assets.map((a) => `${a.sha256}  ${a.name}`).join('\n'),
    assertions: m.assertions,
  });
  requireFact(
    p.expectedCurrentImageId === m.assertions.previousAppImageId,
    'assessment/current-image mismatch'
  );
  requireFact(
    /^[a-f0-9]{64}$/.test(p.helperSha256 ?? ''),
    'verified target helper checksum required'
  );
  requireFact(
    p.platform === 'linux/arm64' || p.platform === 'linux/amd64',
    'exact deployment platform required'
  );
  requireFact(
    Array.isArray(p.retainedReads) &&
      p.retainedReads.length > 0 &&
      p.retainedReads.every(
        (r) =>
          ['thread.read', 'turn.read', 'thread.items', 'artifact.read'].includes(r.operation) &&
          r.input &&
          r.input.workspaceId
      ),
    'selected retained Workspace public reads required'
  );
  requireFact(
    Number.isInteger(p.pollAttempts) &&
      p.pollAttempts > 0 &&
      p.pollAttempts <= 120 &&
      Number.isInteger(p.pollMs) &&
      p.pollMs > 0 &&
      p.pollMs <= 10000,
    'bounded status polling required'
  );
  return p;
}
/** Compare the retained identity core; descriptive additive record fields do not become authority. */
function deploymentBinding(record) {
  return Object.fromEntries(
    ['reference', 'sshAlias', 'origin', 'machineId', 'container'].map((key) => [key, record[key]])
  );
}
/** A matching URL cannot substitute for observation of the exact physical host and container. */
function targetIdentity(actual, deployment) {
  requireFact(
    actual?.machineId === deployment.machineId &&
      actual.container === deployment.container &&
      actual.origin === deployment.origin,
    'live target differs from retained a1 physical identity'
  );
}
/** Read the existing retained deployment artifact without following a link or admitting public bytes. */
async function retainedDeployment(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireFact(
      stat.isFile() && (stat.mode & 0o777) === 0o600,
      'retained deployment record must be regular mode 0600'
    );
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}
/** Require every owned instantaneous work count to agree with idle. */
function idle(observation) {
  requireFact(
    observation?.state === 'idle' &&
      Number.isFinite(Date.parse(observation.observedAt)) &&
      counts.every((k) => observation.counts?.[k] === 0),
    'preflight refuses busy, missing, or contradictory work counts'
  );
}
/** Bind WP2's complete review object to the assessed image and checksum-covered helper bytes. */
function preparedReview(receipt, source, p) {
  requireFact(
    receipt.helperSha256 === p.helperSha256 && receipt.preparedHelperSha256 === p.helperSha256,
    'installed/preparation helper differs from verified target bytes'
  );
  const summary = receipt.approvalSummary;
  requireFact(
    summary &&
      canonical(summary.targetRelease) === canonical(source) &&
      summary.expectedCurrentImageId === p.expectedCurrentImageId &&
      summary.observedCurrentImageId === p.expectedCurrentImageId &&
      typeof summary.interruptionScope === 'string' &&
      summary.interruptionScope.length > 0 &&
      summary.safetyEvidence?.deploymentBindings === true &&
      Array.isArray(summary.recoveryLimitations) &&
      summary.recoveryLimitations.length > 0 &&
      summary.recoveryLimitations.every((limit) => typeof limit === 'string' && limit.length > 0),
    'prepared approval summary is missing or contradicts the bounded assessment'
  );
  idle(summary.safetyEvidence.preflight);
}
/** Submit once, observe the pinned receipt, and compare exact retained public responses. */
export async function updateApp(target, p, dir, io) {
  requireFact(
    typeof io.deploymentRecord === 'function',
    'retained deployment record adapter required'
  );
  const deployment = await io.deploymentRecord();
  validateUpdate(target, p, deployment);
  targetIdentity(await io.identities(target), deployment);
  await fs.mkdir(dir, { mode: 0o700 });
  const now = io.now ?? (() => new Date().toISOString());
  const result = {
    domain: 'app',
    tag: p.manifest.tag,
    sourceCommit: p.manifest.sourceCommit,
    start: now(),
    outcome: 'unknown',
    downstream: 'NanoHost and Worker effects not run',
  };
  const call = async (operation, input) => {
    const data = await io.call(operation, input);
    await save(path.join(dir, `${operation}-${result.observations.length}.json`), {
      at: now(),
      input,
      data,
    });
    result.observations.push(operation);
    return data;
  };
  result.observations = [];
  try {
    idle(await call('app-update.preflight', {}));
    const before = [];
    for (const read of p.retainedReads) before.push(await call(read.operation, read.input));
    const source = {
      tag: p.manifest.tag,
      sourceCommit: p.manifest.sourceCommit,
      appDigest: p.manifest.images.find((i) => i.id === 'app').digest,
    };
    const prepared = await once(
      dir,
      'prepare',
      { source, expectedCurrentImageId: p.expectedCurrentImageId },
      () => call('app-update.prepare', { source, expectedCurrentImageId: p.expectedCurrentImageId })
    );
    requireFact(
      typeof prepared.requestId === 'string' &&
        /^[a-f0-9-]{36}$/i.test(prepared.requestId) &&
        canonical(prepared.source) === canonical(source) &&
        prepared.expectedCurrentImageId === p.expectedCurrentImageId,
      'prepared receipt binding mismatch'
    );
    result.requestId = prepared.requestId;
    preparedReview(prepared, source, p);
    result.approvalSummary = prepared.approvalSummary;
    // Preflight is an instantaneous observation, not an admission barrier; start retains its host lock checks.
    idle(await call('app-update.preflight', {}));
    // The live adapter must read retained administrator authority, never infer it from manifest facts.
    requireFact(
      typeof io.currentGrant === 'function',
      'current administrator grant observation required'
    );
    const grant = await io.currentGrant();
    requireFact(
      grant?.reference === p.grant.reference,
      'standing grant identity changed before start'
    );
    const currentDeployment = await io.deploymentRecord();
    validateUpdate(target, { ...p, grant }, currentDeployment);
    requireFact(
      canonical(deploymentBinding(currentDeployment)) === canonical(deploymentBinding(deployment)),
      'retained deployment binding changed before start'
    );
    targetIdentity(await io.identities(target), deployment);
    await once(dir, 'start', { requestId: prepared.requestId, maintenanceConsent: true }, () =>
      call('app-update.start', { requestId: prepared.requestId, maintenanceConsent: true })
    );
    let status;
    for (let n = 0; n < p.pollAttempts; n++) {
      status = await call('app-update.status', { requestId: prepared.requestId });
      requireFact(
        status.requestId === prepared.requestId && canonical(status.source) === canonical(source),
        'status receipt identity conflict'
      );
      requireFact(
        status.helperSha256 === p.helperSha256 && status.preparedHelperSha256 === p.helperSha256,
        'status helper identity conflict; inspect same request ID'
      );
      if (status.outcome === 'succeeded' || !['prepared', 'running'].includes(status.outcome))
        break;
      await io.sleep(p.pollMs);
    }
    result.receipt = status;
    requireFact(
      status?.outcome === 'succeeded' &&
        predicates.every(
          (k) =>
            status.predicates?.[k] === true ||
            ((k === 'nanohostReady' || k === 'webAssets') && status.predicates?.[k] === null)
        ),
      'receipt failed, incomplete, or unknown; inspect same request ID'
    );
    const identities = await io.identities();
    targetIdentity(identities, deployment);
    const app = p.manifest.images.find((i) => i.id === 'app');
    requireFact(
      identities.sourceCommit === source.sourceCommit &&
        identities.appDigest === app.platforms.find((i) => i.platform === p.platform).digest &&
        identities.webDigest === identities.appDigest,
      'exact live App/platform/Web identity mismatch'
    );
    result.identities = identities;
    for (const [index, read] of p.retainedReads.entries())
      requireFact(
        canonical(await call(read.operation, read.input)) === canonical(before[index]),
        'retained Workspace public read mismatch'
      );
    result.outcome = 'passed';
    return result;
  } catch (error) {
    result.reason = error.message;
    throw error;
  } finally {
    result.end = now();
    await save(path.join(dir, 'app-result.json'), result);
  }
}

/** CLI deliberately refuses until exact live identity observation is admitted; fixtures exercise the composition. */
async function main() {
  const args = process.argv.slice(2),
    options = {};
  while (args.length) {
    const key = args.shift();
    if (
      !['--target', '--params', '--evidence-dir', '--deployment-record'].includes(key) ||
      options[key] ||
      !args.length
    )
      throw Error(
        'Usage: release-update-app.mjs --target URL --params FILE --deployment-record FILE --evidence-dir NEW_DIR'
      );
    options[key] = args.shift();
  }
  if (
    !options['--target'] ||
    !options['--params'] ||
    !options['--evidence-dir'] ||
    !options['--deployment-record']
  )
    throw Error(
      'Explicit target, params, retained deployment record and new evidence directory required'
    );
  const p = JSON.parse(await fs.readFile(options['--params'], 'utf8'));
  validateUpdate(options['--target'], p, await retainedDeployment(options['--deployment-record']));
  // Do not infer an OCI platform digest from Docker image ID or a version label.
  throw Error(
    'App update automation is not executable: exact live platform identity adapter is pending'
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
