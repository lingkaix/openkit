/** Bounded Worker release stage through the existing preparation and activation owners. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ActivateWorkerEnvironmentRequestSchema,
  ActivateWorkerEnvironmentResponseSchema,
  AppUpdatePreflightResponseSchema,
  PrepareWorkerEnvironmentResponseSchema,
  WorkerEnvironmentPrepareInputSchema,
} from '@openkit/app-api-schemas';
import { createReleaseManifest } from '../release-record.mjs';
import { canonical, noSecrets, once, save } from '../release-safety.mjs';
import {
  admitArchiveAttribution,
  admitHostObservation,
  observeOperatorHost,
} from './host-observation.mjs';

/** Only locally authored refusal text may enter an update result or caller error. */
class WorkerUpdateStop extends Error {}

/** Refuse with a fixed diagnostic that cannot copy host errors or credential material. */
function requireFact(condition, reason) {
  if (!condition) throw new WorkerUpdateStop(`Worker update: ${reason}`);
}

/** Validate a public boundary without exposing parser issues or their input values. */
function admit(schema, value, reason) {
  const parsed = schema.safeParse(value);
  requireFact(parsed.success, reason);
  return parsed.data;
}

/** Reuse the release manifest owner rather than creating another image or assessment parser. */
function releaseSelection(p) {
  requireFact(p.manifest?.schemaVersion === 1, 'unsupported release manifest');
  const m = p.manifest;
  const manifest = createReleaseManifest({
    repository: m.repository,
    tag: m.tag,
    sha: m.sourceCommit,
    images: m.images.map((image) => ({
      ...image,
      prerelease: true,
      tags: [m.tag, m.tag.slice(1), `sha-${m.sourceCommit.slice(0, 12)}`],
    })),
    checksums: m.assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n'),
    assertions: m.assertions,
  });
  requireFact(['linux/amd64', 'linux/arm64'].includes(p.platform), 'unsupported platform');
  const image = manifest.images.find((item) => item.id === 'worker-runtimes');
  const child = image?.platforms.find((item) => item.platform === p.platform);
  const distribution = manifest.assets.find(
    (asset) =>
      asset.name === `openkit-nanohost-${manifest.tag}-${p.platform.replace('/', '-')}.tar.gz`
  );
  requireFact(child && distribution, 'missing release image or distribution');
  return { manifest, image, child, distribution };
}

/** Admit the same retained staging binding used by the App update stage; ignore annotations. */
function deploymentBinding(target, record) {
  requireFact(
    record?.origin === target &&
      record.sshAlias === 'a1' &&
      typeof record.reference === 'string' &&
      record.reference.length > 0 &&
      /^[a-f0-9]{64}$/.test(record.machineIdentityDigest ?? '') &&
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(record.container ?? ''),
    'retained staging deployment binding unavailable'
  );
  return Object.fromEntries(
    ['reference', 'sshAlias', 'origin', 'machineIdentityDigest', 'container'].map((key) => [
      key,
      record[key],
    ])
  );
}

/** A manifest describes compatible bytes; only an independently read current grant admits effects. */
function requireGrant(target, grant, binding) {
  requireFact(
    grant?.target === target &&
      grant.environment === 'staging-test' &&
      grant.revoked === false &&
      typeof grant.reference === 'string' &&
      grant.reference.length > 0 &&
      grant.deploymentReference === binding.reference &&
      grant.maintenance === 'idle-only' &&
      Array.isArray(grant.operations) &&
      grant.operations.includes('worker-environment'),
    'current bounded Worker grant unavailable'
  );
  noSecrets(grant);
}

/** Bind independently verified archive attribution to the selected release publication. */
function selectedArchive(raw, selection, platform) {
  const archive = admitArchiveAttribution(raw);
  requireFact(
    archive.archiveSha256 === selection.distribution.sha256 &&
      archive.tag === selection.manifest.tag &&
      archive.sourceCommit === selection.manifest.sourceCommit &&
      archive.platform === platform,
    'verified NanoHost archive does not match the selected release'
  );
  return archive;
}

/** A new sample cannot silently replace a connection or process already used by this attempt. */
function sameIncarnation(left, right) {
  return (
    left.physicalEpoch === right.physicalEpoch &&
    canonical(left.runtimeTarget) ===
      canonical({ ...right.runtimeTarget, observedAt: left.runtimeTarget.observedAt }) &&
    canonical(left.inspection.coordinator) === canonical(right.inspection.coordinator) &&
    canonical(left.inspection.executables) === canonical(right.inspection.executables)
  );
}

/** Bind the existing upstream component evidence; an asserted historical witness cannot prove replacement. */
function replacementObservation(raw, target, p, binding, grant, host, selection) {
  requireFact(
    raw?.outcome === 'passed' &&
      raw.reference === p.nanoHostReplacementReference &&
      raw.target === target &&
      raw.grantReference === grant.reference &&
      raw.release?.tag === selection.manifest.tag &&
      raw.release.sourceCommit === selection.manifest.sourceCommit,
    'accepted NanoHost replacement evidence for this invocation required'
  );
  const previous = admitHostObservation(raw.before, {
    binding,
    archiveAttribution: raw.before?.archiveAttribution,
    effectiveStateDigest: raw.before?.inspection?.unit?.effectiveStateDigest,
  });
  const successor = admitHostObservation(raw.after, {
    binding,
    archiveAttribution: host.archiveAttribution,
    effectiveStateDigest: host.inspection.unit.effectiveStateDigest,
  });
  requireFact(
    previous.physicalEpoch === p.previousPhysicalEpoch &&
      previous.physicalEpoch !== successor.physicalEpoch &&
      previous.runtimeTarget.identityId === host.runtimeTarget.identityId &&
      previous.runtimeTarget.deploymentId === host.runtimeTarget.deploymentId &&
      successor.runtimeTarget.connectionGeneration > previous.runtimeTarget.connectionGeneration &&
      sameIncarnation(successor, host),
    'NanoHost replacement does not prove the selected predecessor and current fresh Epoch'
  );
  return {
    reference: raw.reference,
    outcome: 'passed',
    release: { tag: selection.manifest.tag, sourceCommit: selection.manifest.sourceCommit },
    before: previous,
    after: successor,
  };
}

/** Require all instantaneous work counts to be zero; the runtime owner still owns the drain fence. */
function requireIdle(raw) {
  const observation = admit(
    AppUpdatePreflightResponseSchema.strip(),
    raw,
    'work preflight unavailable'
  );
  requireFact(
    observation.state === 'idle' && Object.values(observation.counts).every((value) => value === 0),
    'active work prevents the bounded update'
  );
  return observation;
}

/**
 * Compose one fresh-Epoch Worker preparation and exact administrator activation.
 * The trusted administrator adapter supplies independent observations and current authority.
 * Existing operations retain image settlement, compatibility, drain, writer fencing and replay.
 * A thrown or partial result stops this attempt; its evidence directory cannot be reused.
 * @param {string} target Explicit authorized HTTPS origin with no default.
 * @param {object} params Verified manifest, public preparation baseline, request IDs and grant.
 * @param {string} evidenceDir New private evidence directory outside the product's canonical storage.
 * @param {object} io Administrator operation caller and independent deployment, grant and host readers.
 * @returns {Promise<object>} Separate preparation and activation observations, never runtime qualification.
 */
export async function updateWorkerEnvironment(target, params, evidenceDir, io) {
  // Exclusive creation is also the local uncertainty fence: no read or mutation runs on reentry.
  await fs.mkdir(evidenceDir, { mode: 0o700 });
  const result = { domain: 'worker', outcome: 'stopped', stage: 'admission' };
  try {
    const url = new URL(target);
    requireFact(
      url.protocol === 'https:' &&
        url.origin === target &&
        !url.username &&
        !url.password &&
        url.hostname !== 'a2',
      'explicit HTTPS staging origin required'
    );
    const p = structuredClone(params);
    noSecrets(p);
    requireFact(
      p &&
        Object.keys(p).every((key) =>
          [
            'manifest',
            'platform',
            'prepare',
            'activationRequestId',
            'grant',
            'previousPhysicalEpoch',
            'nanoHostReplacementReference',
          ].includes(key)
        ),
      'unknown update instruction'
    );
    requireFact(
      [
        'call',
        'deploymentRecord',
        'currentGrant',
        'inspectHost',
        'archiveAttribution',
        'replacementObservation',
      ].every((key) => typeof io?.[key] === 'function'),
      'independent administrator adapters required'
    );
    const selection = releaseSelection(p);
    requireFact(
      /^[a-f0-9]{64}$/.test(p.previousPhysicalEpoch ?? '') &&
        typeof p.nanoHostReplacementReference === 'string' &&
        p.nanoHostReplacementReference.length > 0 &&
        p.nanoHostReplacementReference.length <= 128 &&
        !Object.hasOwn(p.prepare ?? {}, 'declaration'),
      'replacement evidence reference, previous Epoch and release-derived declaration required'
    );
    const request = admit(
      WorkerEnvironmentPrepareInputSchema,
      {
        ...p.prepare,
        declaration: {
          kind: 'reference',
          ref: `${selection.image.image}@${selection.image.digest}`,
          pullPolicy: 'always',
        },
      },
      'invalid preparation request'
    );
    // Validate the independent activation ID with its real schema before dispatching preparation.
    requireFact(
      ActivateWorkerEnvironmentRequestSchema.shape.requestId.safeParse(p.activationRequestId)
        .success && p.activationRequestId !== request.requestId,
      'distinct valid activation request ID required'
    );
    const binding = deploymentBinding(target, await io.deploymentRecord());
    requireGrant(target, p.grant, binding);
    const grant = structuredClone(await io.currentGrant());
    requireGrant(target, grant, binding);
    requireFact(canonical(grant) === canonical(p.grant), 'grant changed before preparation');
    const archiveAttribution = selectedArchive(
      await io.archiveAttribution(),
      selection,
      p.platform
    );
    const upstream = structuredClone(await io.replacementObservation(target));
    // The separately accepted stage is the configuration authority; the archive alone is not.
    const expected = {
      binding,
      archiveAttribution,
      effectiveStateDigest: upstream?.after?.inspection?.unit?.effectiveStateDigest,
    };
    const host = await observeOperatorHost(target, expected, io);
    requireFact(
      host.physicalEpoch !== p.previousPhysicalEpoch && host.runtimeTarget.freshEmpty,
      'fresh physical Epoch evidence required before registry preparation'
    );
    result.nanoHostReplacement = replacementObservation(
      upstream,
      target,
      p,
      binding,
      grant,
      host,
      selection
    );
    result.release = {
      tag: selection.manifest.tag,
      sourceCommit: selection.manifest.sourceCommit,
      platform: p.platform,
    };
    result.host = host;
    result.preflight = requireIdle(await io.call('app-update.preflight', {}));
    result.stage = 'prepare';
    result.outcome = 'unknown';
    const callEffect = async (operation, input) => {
      try {
        const output = await io.call(operation, structuredClone(input));
        return admit(
          operation === 'worker-environment.prepare'
            ? PrepareWorkerEnvironmentResponseSchema.strip()
            : ActivateWorkerEnvironmentResponseSchema.strip(),
          output,
          `${operation === 'worker-environment.prepare' ? 'preparation' : 'activation'} observation invalid; inspection required`
        );
      } catch (error) {
        if (error instanceof WorkerUpdateStop) throw error;
        throw new WorkerUpdateStop(
          'Worker update: operation outcome unknown; inspect the saved request ID'
        );
      }
    };
    const prepared = await once(evidenceDir, 'prepare', request, () =>
      callEffect('worker-environment.prepare', request)
    );
    result.prepared = prepared;
    requireFact(
      prepared.requestId === request.requestId &&
        canonical(prepared.configuration) === canonical(request.configuration) &&
        canonical(prepared.target) === canonical(request.target) &&
        canonical(prepared.replaceNow) === canonical(request.replaceNow ?? null) &&
        prepared.image.digest === selection.child.digest &&
        `${prepared.image.platform.os}/${prepared.image.platform.architecture}` === p.platform,
      'prepared release, configuration or affected-work binding changed'
    );
    result.outcome = 'prepared';
    result.stage = 'activation-admission';
    const currentBinding = deploymentBinding(target, await io.deploymentRecord());
    requireFact(
      canonical(currentBinding) === canonical(binding),
      'deployment binding changed before activation'
    );
    const currentGrant = await io.currentGrant();
    requireGrant(target, currentGrant, currentBinding);
    requireFact(canonical(currentGrant) === canonical(grant), 'grant changed before activation');
    const currentHost = await observeOperatorHost(target, expected, io);
    requireFact(sameIncarnation(currentHost, host), 'host incarnation changed before activation');
    result.hostBeforeActivation = currentHost;
    result.preflightBeforeActivation = requireIdle(await io.call('app-update.preflight', {}));
    const activationRequest = admit(
      ActivateWorkerEnvironmentRequestSchema,
      {
        requestId: p.activationRequestId,
        resolvedCandidate: prepared.resolvedCandidate,
        configuration: prepared.configuration,
        target: prepared.target,
        replaceNow: prepared.replaceNow,
        affectedStorage: prepared.affectedStorage,
        confirmation: prepared.activationConfirmation,
      },
      'prepared activation confirmation unavailable'
    );
    result.stage = 'activate';
    result.outcome = 'unknown';
    const activation = await once(evidenceDir, 'activate', activationRequest, () =>
      callEffect('worker-environment.activate', activationRequest)
    );
    result.activation = activation;
    requireFact(
      activation.requestId === activationRequest.requestId &&
        canonical(activation.resolvedCandidate) === canonical(prepared.resolvedCandidate) &&
        canonical(activation.target) === canonical(prepared.target) &&
        canonical(activation.replaceNow) === canonical(prepared.replaceNow) &&
        activation.configuration?.fileId === prepared.configuration.fileId &&
        canonical(activation.affected.map(({ disposition: _, ...entry }) => entry)) ===
          canonical(prepared.affectedStorage) &&
        activation.affected.every((entry) => entry.disposition === 'reattached'),
      'activation is partial, contradictory or unknown; inspect without retry'
    );
    result.stage = 'verification';
    const afterHost = await observeOperatorHost(target, expected, io);
    requireFact(
      sameIncarnation(afterHost, currentHost),
      'host incarnation changed after activation; inspection required'
    );
    result.hostAfterActivation = afterHost;
    result.outcome = 'activated';
    result.freshEpochPreparation = true;
    return result;
  } catch (error) {
    // Keep transport, parser and adapter exception text out of evidence and callers.
    result.reason =
      error instanceof WorkerUpdateStop
        ? error.message
        : `Worker update: ${result.stage} observation unavailable; inspect retained evidence before any new effect.`;
    throw new WorkerUpdateStop(result.reason);
  } finally {
    await save(path.join(evidenceDir, 'worker-result.json'), result);
  }
}
