/** Bounded external operator NanoHost replacement through the unchanged installer. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppUpdatePreflightResponseSchema } from '@openkit/app-api-schemas';
import { z } from 'zod';
import { createReleaseManifest } from '../release-record.mjs';
import { canonical, noSecrets, once, save } from '../release-safety.mjs';
import { admitArchiveAttribution, observeOperatorHost } from './host-observation.mjs';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceCommit = z.string().regex(/^[a-f0-9]{40}$/);
const imageDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const reference = z.string().min(1).max(128);
const processStamp = z.object({
  bootId: z.string().uuid(),
  pid: z.number().int().positive().max(2_147_483_647),
  startTimeTicks: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n),
});
const payloads = z.object({
  nanohostSha256: digest,
  gatewaySha256: digest,
  unitFileSha256: digest,
});
// This is protected operator assessment, not a compatibility verdict derived from manifest assertions.
const pairAssessment = z.strictObject({
  reference,
  order: z.literal('app-first'),
  previousNanoHostArchiveSha256: digest,
  targetNanoHostArchiveSha256: digest,
  appSourceCommit: sourceCommit,
  appDigest: imageDigest,
  admissionCompatible: z.literal(true),
  readinessCompatible: z.literal(true),
  commandCompatible: z.literal(true),
  recoveryCompatible: z.literal(true),
});
const grantSchema = z.strictObject({
  reference,
  target: z.string(),
  environment: z.literal('staging-test'),
  revoked: z.literal(false),
  operations: z.array(z.enum(['app-update', 'nanohost', 'worker-environment'])),
  maintenance: z.literal('idle-only'),
  deploymentReference: reference,
  transitionalPairAssessment: pairAssessment,
});
const bindingSchema = z.object({
  reference,
  sshAlias: z.literal('a1'),
  origin: z.string(),
  machineIdentityDigest: digest,
  container: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
});
const releaseSchema = z.object({ tag: z.string(), sourceCommit });
const appEvidenceSchema = z.object({
  reference,
  invocationReference: reference,
  target: z.string(),
  grantReference: reference,
  deploymentReference: reference,
  release: releaseSchema,
  transitionalPairAssessment: pairAssessment,
  result: z.object({
    domain: z.literal('app'),
    outcome: z.literal('passed'),
    tag: z.string(),
    sourceCommit,
    requestId: z.string().uuid(),
    receipt: z.object({
      requestId: z.string().uuid(),
      outcome: z.literal('succeeded'),
      source: releaseSchema.extend({ appDigest: imageDigest }),
    }),
    identities: z.object({ sourceCommit, appDigest: imageDigest, webDigest: imageDigest }),
  }),
});
const stepBase = { outcome: z.literal('passed') };
const fenced = { fenced: z.literal(true), inhibited: z.literal(true) };
// The fixed host adapter proves structure before supplying opaque P02 digests. This module never normalizes unit properties.
const stepSchemas = {
  preflight: z.object({
    ...stepBase,
    action: z.literal('preflight'),
    posture: z.literal('canonical-systemd'),
    retainedInputsDigest: digest,
    stockEffectiveStateDigest: digest,
  }),
  begin: z.object({ ...stepBase, action: z.literal('begin'), ...fenced }),
  vacate: z.object({
    ...stepBase,
    action: z.literal('vacate'),
    ...fenced,
    custodyVerified: z.literal(true),
  }),
  install: z.object({
    ...stepBase,
    action: z.literal('install'),
    ...fenced,
    payloads,
    retainedInputsDigest: digest,
  }),
  start: z.object({
    ...stepBase,
    action: z.literal('start'),
    process: processStamp,
    controlledEffectiveStateDigest: digest,
  }),
  finalize: z.object({
    ...stepBase,
    action: z.literal('finalize'),
    process: processStamp,
    payloads,
    retainedInputsDigest: digest,
    supervisionRestored: z.literal(true),
    effectiveStateDigest: digest,
  }),
};

/** Refusals have fixed local text, including exceptions from private operator adapters. */
class NanoHostUpdateStop extends Error {}

/** Refuse a violated release-owner prerequisite without copying host data into diagnostics. */
function requireFact(condition, reason) {
  if (!condition) throw new NanoHostUpdateStop(`NanoHost update: ${reason}`);
}

/** Strip inert observation additions; authority-bearing input schemas remain strict. */
function admit(schema, raw, reason) {
  const parsed = schema.safeParse(raw);
  requireFact(parsed.success, reason);
  return parsed.data;
}

/** Validate publication through its existing owner and select one exact platform distribution. */
function selectionFor(p) {
  const m = p.manifest;
  requireFact(m?.schemaVersion === 1, 'unsupported release manifest');
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
  const distribution = manifest.assets.find(
    (asset) =>
      asset.name === `openkit-nanohost-${manifest.tag}-${p.platform.replace('/', '-')}.tar.gz`
  );
  const app = manifest.images.find((image) => image.id === 'app');
  const child = app?.platforms.find((image) => image.platform === p.platform);
  requireFact(distribution && child, 'missing release distribution or App platform');
  return { manifest, distribution, app, child };
}

/** Compare an entire observed incarnation, allowing only the public observation time to advance. */
function sameIncarnation(left, right) {
  return (
    left.physicalEpoch === right.physicalEpoch &&
    canonical(left.runtimeTarget) ===
      canonical({ ...right.runtimeTarget, observedAt: left.runtimeTarget.observedAt }) &&
    canonical(left.inspection.coordinator) === canonical(right.inspection.coordinator) &&
    canonical(left.inspection.executables) === canonical(right.inspection.executables)
  );
}

/** Admit a fresh successor of the exact configured pair; a reconnect is insufficient. */
function requireSuccessor(before, after, process) {
  requireFact(
    after.physicalEpoch !== before.physicalEpoch &&
      after.runtimeTarget.identityId === before.runtimeTarget.identityId &&
      after.runtimeTarget.deploymentId === before.runtimeTarget.deploymentId &&
      after.runtimeTarget.connectionGeneration > before.runtimeTarget.connectionGeneration &&
      canonical(after.inspection.coordinator) === canonical(process),
    'successor Epoch, configured pair, generation or process does not match'
  );
}

/**
 * Replace one selected NanoHost through six fixed, independently bounded operator steps.
 * The trusted operator adapter verifies fencing, immutable installer inputs, retained metadata, canonical systemd structure and supervision restoration; P02 owns all live unit digests.
 * Separate successful App evidence must belong to this invocation and protected release-pair assessment.
 * An incomplete or lost effect has no retry or compensation path; use retained evidence for inspection.
 * @param {string} target Explicit authorized HTTPS staging origin with no default.
 * @param {object} params Selected manifest/platform, current grant, references and accepted old unit digest.
 * @param {string} evidenceDir New private directory, never a product record or resume authority.
 * @param {object} io Independent authority, archive and App readers, public caller and fixed operator adapters.
 * @returns {Promise<object>} Separate component evidence accepted by the existing Worker stage.
 */
export async function updateNanoHost(target, params, evidenceDir, io) {
  await fs.mkdir(evidenceDir, { mode: 0o700 });
  const result = { domain: 'nanohost', outcome: 'stopped', stage: 'admission' };
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
            'grant',
            'replacementId',
            'reference',
            'appUpdateReference',
            'invocationReference',
            'previousEffectiveStateDigest',
          ].includes(key)
        ),
      'unknown update instruction'
    );
    admit(
      z.strictObject({
        replacementId: z
          .string()
          .uuid()
          .refine((value) => value === value.toLowerCase()),
        reference,
        appUpdateReference: reference,
        invocationReference: reference,
        previousEffectiveStateDigest: digest,
      }),
      {
        replacementId: p.replacementId,
        reference: p.reference,
        appUpdateReference: p.appUpdateReference,
        invocationReference: p.invocationReference,
        previousEffectiveStateDigest: p.previousEffectiveStateDigest,
      },
      'invalid invocation references or previous unit baseline'
    );
    requireFact(
      [
        'deploymentRecord',
        'currentGrant',
        'archiveAttribution',
        'appUpdateObservation',
        'call',
        'runOperator',
        'runNanoHostStep',
      ].every((key) => typeof io?.[key] === 'function'),
      'independent administrator adapters required'
    );
    const selection = selectionFor(p);
    const binding = admit(
      bindingSchema,
      await io.deploymentRecord(),
      'retained staging deployment binding unavailable'
    );
    requireFact(binding.origin === target, 'retained staging target differs');
    const grant = admit(grantSchema, p.grant, 'current bounded NanoHost grant unavailable');
    requireFact(
      grant.target === target &&
        grant.deploymentReference === binding.reference &&
        grant.operations.includes('nanohost') &&
        grant.operations.includes('app-update'),
      'bounded NanoHost and preceding App authority required'
    );
    const old = admitArchiveAttribution(await io.archiveAttribution('old'));
    const candidate = admitArchiveAttribution(await io.archiveAttribution('target'));
    const assessment = grant.transitionalPairAssessment;
    requireFact(
      old.platform === p.platform &&
        candidate.platform === p.platform &&
        candidate.archiveSha256 === selection.distribution.sha256 &&
        candidate.tag === selection.manifest.tag &&
        candidate.sourceCommit === selection.manifest.sourceCommit &&
        assessment.previousNanoHostArchiveSha256 === old.archiveSha256 &&
        assessment.targetNanoHostArchiveSha256 === candidate.archiveSha256 &&
        assessment.appSourceCommit === selection.manifest.sourceCommit &&
        assessment.appDigest === selection.app.digest,
      'verified archive pair or protected App-first assessment does not match release'
    );

    /** Re-read every authority and instantaneous impact before the next fixed host effect. */
    const authority = async () => {
      const currentBinding = admit(
        bindingSchema,
        await io.deploymentRecord(),
        'current deployment binding unavailable'
      );
      requireFact(
        canonical(currentBinding) === canonical(binding),
        'deployment binding changed; inspection required'
      );
      const currentGrant = admit(
        grantSchema,
        await io.currentGrant(),
        'current bounded NanoHost grant unavailable'
      );
      requireFact(
        canonical(currentGrant) === canonical(grant),
        'grant changed; inspection required'
      );
      const app = admit(
        appEvidenceSchema,
        await io.appUpdateObservation(target),
        'separate successful App evidence required'
      );
      requireFact(
        app.reference === p.appUpdateReference &&
          app.invocationReference === p.invocationReference &&
          app.target === target &&
          app.grantReference === grant.reference &&
          app.deploymentReference === binding.reference &&
          app.release.tag === selection.manifest.tag &&
          app.release.sourceCommit === selection.manifest.sourceCommit &&
          canonical(app.transitionalPairAssessment) === canonical(assessment) &&
          app.result.tag === app.release.tag &&
          app.result.sourceCommit === app.release.sourceCommit &&
          app.result.receipt.requestId === app.result.requestId &&
          app.result.receipt.source.tag === app.release.tag &&
          app.result.receipt.source.sourceCommit === app.release.sourceCommit &&
          app.result.receipt.source.appDigest === selection.app.digest &&
          app.result.identities.sourceCommit === app.release.sourceCommit &&
          app.result.identities.appDigest === selection.child.digest &&
          app.result.identities.webDigest === selection.child.digest,
        'preceding App evidence is stale, unbound or contradictory'
      );
      if (result.appUpdate)
        requireFact(
          canonical(result.appUpdate) === canonical(app),
          'preceding App evidence changed during replacement'
        );
      const preflight = admit(
        AppUpdatePreflightResponseSchema.strip(),
        await io.call('app-update.preflight', {}),
        'work preflight unavailable'
      );
      requireFact(
        preflight.state === 'idle' && Object.values(preflight.counts).every((count) => count === 0),
        'active work prevents the bounded update'
      );
      return { app, preflight };
    };
    const initial = await authority();
    result.appUpdate = initial.app;
    result.preflight = initial.preflight;
    result.reference = p.reference;
    result.invocationReference = p.invocationReference;
    result.target = target;
    result.grantReference = grant.reference;
    result.release = { tag: selection.manifest.tag, sourceCommit: selection.manifest.sourceCommit };
    const oldExpected = {
      binding,
      archiveAttribution: old,
      effectiveStateDigest: p.previousEffectiveStateDigest,
    };
    result.before = await observeOperatorHost(target, oldExpected, io);

    /** Save the attempt before invocation; sanitize failure before the shared helper retains it. */
    const step = async (action, process) => {
      result.stage = `${action}-admission`;
      const admission = await authority();
      await save(path.join(evidenceDir, `${action}-admission.json`), admission);
      if (action === 'begin') {
        const current = await observeOperatorHost(target, oldExpected, io);
        requireFact(
          sameIncarnation(result.before, current),
          'predecessor changed before maintenance'
        );
        result.beforeBegin = current;
      }
      result.stage = action;
      result.outcome = 'unknown';
      const request = {
        action,
        replacementId: p.replacementId,
        old,
        target: candidate,
        ...(process ? { process } : {}),
      };
      return once(evidenceDir, action, request, async () => {
        try {
          return admit(
            stepSchemas[action],
            await io.runNanoHostStep(target, structuredClone(request)),
            `${action} result unavailable; inspect retained attempt without retry`
          );
        } catch (error) {
          if (error instanceof NanoHostUpdateStop) throw error;
          throw new NanoHostUpdateStop(
            `NanoHost update: ${action} outcome unknown; inspect retained attempt without retry`
          );
        }
      });
    };
    const preflight = await step('preflight');
    requireFact(
      preflight.stockEffectiveStateDigest === p.previousEffectiveStateDigest,
      'old effective unit baseline changed'
    );
    result.hostPreflight = preflight;
    result.maintenance = await step('begin');
    result.custody = await step('vacate');
    result.installation = await step('install');
    requireFact(
      canonical(result.installation.payloads) === canonical(candidate.payloads) &&
        result.installation.retainedInputsDigest === preflight.retainedInputsDigest,
      'installed target or retained inputs changed'
    );
    result.started = await step('start');
    const controlledExpected = {
      binding,
      archiveAttribution: candidate,
      effectiveStateDigest: result.started.controlledEffectiveStateDigest,
    };
    result.stage = 'controlled-readiness';
    const controlled = await observeOperatorHost(target, controlledExpected, io);
    requireSuccessor(result.before, controlled, result.started.process);
    result.beforeFinalization = controlled;
    result.finalization = await step('finalize', controlled.inspection.coordinator);
    requireFact(
      canonical(result.finalization.process) === canonical(controlled.inspection.coordinator) &&
        canonical(result.finalization.payloads) === canonical(candidate.payloads) &&
        result.finalization.retainedInputsDigest === preflight.retainedInputsDigest &&
        result.finalization.effectiveStateDigest !== result.started.controlledEffectiveStateDigest,
      'stock supervision, target payloads, retained inputs or process unproved'
    );
    result.stage = 'final-readiness';
    const after = await observeOperatorHost(
      target,
      {
        binding,
        archiveAttribution: candidate,
        effectiveStateDigest: result.finalization.effectiveStateDigest,
      },
      io
    );
    requireSuccessor(result.before, after, result.started.process);
    requireFact(
      sameIncarnation(controlled, after),
      'host incarnation changed after supervision restoration'
    );
    // A passed result can contain only the post-restoration P02 sample as its Worker baseline.
    result.after = after;
    result.outcome = 'passed';
    return result;
  } catch (error) {
    result.reason =
      error instanceof NanoHostUpdateStop
        ? error.message
        : `NanoHost update: ${result.stage} observation unavailable; inspect retained evidence before any new effect.`;
    throw new NanoHostUpdateStop(result.reason);
  } finally {
    await save(path.join(evidenceDir, 'nanohost-result.json'), result);
  }
}
