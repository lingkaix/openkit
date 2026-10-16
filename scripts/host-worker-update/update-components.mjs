/** One external administrator composition over the existing component effect owners. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ActivateWorkerEnvironmentRequestSchema,
  WorkerEnvironmentPrepareInputSchema,
} from '@openkit/app-api-schemas';
import { z } from 'zod';
import { canonical, noSecrets, save } from '../release-safety.mjs';
import { updateApp, validateUpdate } from '../release-update-app.mjs';
import { observeOperatorHost } from './host-observation.mjs';
import { admitNanoHostReleasePair, updateNanoHost } from './update-nanohost.mjs';
import { updateWorkerEnvironment } from './update-worker-environment.mjs';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const parameters = z.strictObject({
  manifest: z.unknown(),
  platform: z.enum(['linux/amd64', 'linux/arm64']),
  grant: z.unknown(),
  invocationReference: z.string().min(1).max(118),
  app: z.strictObject({
    expectedCurrentImageId: z.string(),
    helperSha256: digest,
    retainedReads: z.array(z.unknown()),
    pollAttempts: z.number().int(),
    pollMs: z.number().int(),
  }),
  nanoHost: z.strictObject({
    replacementId: z
      .string()
      .uuid()
      .refine((value) => value === value.toLowerCase()),
    previousEffectiveStateDigest: digest,
  }),
  worker: z.strictObject({
    prepare: WorkerEnvironmentPrepareInputSchema.omit({ declaration: true }),
    activationRequestId: ActivateWorkerEnvironmentRequestSchema.shape.requestId,
  }),
});

/** Only fixed local diagnostic text can escape a component or enter its result. */
class ComponentUpdateStop extends Error {}

/** Fail closed at the composition seam without copying private adapter inputs or errors. */
function requireFact(condition, reason) {
  if (!condition) throw new ComponentUpdateStop(`Component update: ${reason}`);
}

/**
 * Run the actual App, NanoHost and Worker stages once, in that fixed order.
 * Protected current authority and independently verified old/target archives admit the App-first pair before App effects.
 * Prior-component readers close over actual results from this invocation; caller assertions cannot replace them.
 * Each owner retains its own effects and evidence, while failure leaves all dependent stages unproved.
 * @param {string} target One explicit authorized HTTPS staging origin.
 * @param {object} params Shared release, platform, grant and invocation plus closed component-specific inputs.
 * @param {string} evidenceDir New private parent directory with separate app, nanohost and worker children.
 * @param {object} io Independent administrator readers, public caller and fixed operator adapters.
 * @returns {Promise<object>} Separate component outcomes, without a release-qualification verdict.
 */
export async function updateComponents(target, params, evidenceDir, io) {
  await fs.mkdir(evidenceDir, { mode: 0o700 });
  const result = {
    domain: 'components',
    outcome: 'stopped',
    stage: 'admission',
    components: {
      app: { outcome: 'not-run' },
      nanohost: { outcome: 'not-run' },
      worker: { outcome: 'not-run' },
    },
  };
  try {
    const input = structuredClone(params);
    noSecrets(input);
    const parsed = parameters.safeParse(input);
    requireFact(parsed.success, 'closed release and component inputs required');
    const p = parsed.data;
    requireFact(
      p.worker.prepare.requestId !== p.worker.activationRequestId,
      'distinct Worker request IDs required'
    );
    requireFact(
      [
        'deploymentRecord',
        'currentGrant',
        'archiveAttribution',
        'identities',
        'sleep',
        'call',
        'runOperator',
        'runNanoHostStep',
      ].every((key) => typeof io?.[key] === 'function'),
      'independent administrator adapters required'
    );
    const common = { manifest: p.manifest, platform: p.platform, grant: p.grant };
    const nanoHostParams = {
      ...common,
      ...p.nanoHost,
      reference: `${p.invocationReference}:nanohost`,
      appUpdateReference: `${p.invocationReference}:app`,
      invocationReference: p.invocationReference,
    };
    const admission = await admitNanoHostReleasePair(target, nanoHostParams, io);
    requireFact(
      admission.grant.operations.includes('worker-environment'),
      'complete component authority required'
    );
    const appParams = { ...common, ...p.app };
    const appDeployment = await io.deploymentRecord();
    validateUpdate(target, appParams, appDeployment);
    requireFact(
      Object.keys(admission.binding).every((key) => appDeployment[key] === admission.binding[key]),
      'deployment changed before App admission'
    );
    result.target = target;
    result.invocationReference = p.invocationReference;
    result.release = {
      tag: admission.selection.manifest.tag,
      sourceCommit: admission.selection.manifest.sourceCommit,
      platform: p.platform,
    };
    result.components.app.reference = nanoHostParams.appUpdateReference;
    result.components.nanohost.reference = nanoHostParams.reference;
    await save(path.join(evidenceDir, 'components-intent.json'), {
      target,
      invocationReference: p.invocationReference,
      release: result.release,
      manifest: admission.selection.manifest,
      binding: admission.binding,
      grant: admission.grant,
      old: admission.old,
      targetArchive: admission.candidate,
    });

    // The App owner predates digest-based host admission. Pin both representations in memory, and never retain its raw machine identifier here.
    const componentIO = {
      ...io,
      deploymentRecord: async () => {
        const current = await io.deploymentRecord();
        requireFact(
          Object.keys(admission.binding).every((key) => current[key] === admission.binding[key]) &&
            current.machineId === appDeployment.machineId,
          'deployment binding changed; inspection required'
        );
        return current;
      },
      currentGrant: async () => {
        const current = await io.currentGrant();
        requireFact(
          canonical(current) === canonical(admission.grant),
          'current grant or protected assessment changed'
        );
        return current;
      },
    };
    // App retains thrown text under its existing owner. Sanitize each external adapter failure before it reaches that retention boundary.
    const appIO = Object.fromEntries(
      ['deploymentRecord', 'currentGrant', 'identities', 'sleep', 'call'].map((key) => [
        key,
        async (...args) => {
          try {
            if (key === 'call' && ['app-update.prepare', 'app-update.start'].includes(args[0])) {
              await componentIO.currentGrant();
              await componentIO.deploymentRecord();
            }
            return await componentIO[key](...args);
          } catch (error) {
            if (error instanceof ComponentUpdateStop) throw error;
            throw new ComponentUpdateStop(
              'Component update: App observation or effect unavailable; inspect its saved request before any new effect.'
            );
          }
        },
      ])
    );
    const beforeApp = await observeOperatorHost(
      target,
      {
        binding: admission.binding,
        archiveAttribution: admission.old,
        effectiveStateDigest: p.nanoHost.previousEffectiveStateDigest,
      },
      componentIO
    );
    await save(path.join(evidenceDir, 'app-host-admission.json'), beforeApp);
    result.stage = 'app';
    result.outcome = 'unknown';
    result.components.app.outcome = 'unknown';
    const app = await updateApp(target, appParams, path.join(evidenceDir, 'app'), appIO);
    requireFact(app.outcome === 'passed', 'App did not establish its own successful result');
    result.components.app = {
      outcome: 'passed',
      reference: nanoHostParams.appUpdateReference,
      requestId: app.requestId,
    };
    const appEvidence = {
      reference: nanoHostParams.appUpdateReference,
      invocationReference: p.invocationReference,
      target,
      grantReference: admission.grant.reference,
      deploymentReference: admission.binding.reference,
      release: { tag: result.release.tag, sourceCommit: result.release.sourceCommit },
      transitionalPairAssessment: admission.grant.transitionalPairAssessment,
      result: app,
    };
    result.stage = 'nanohost';
    result.components.nanohost.outcome = 'unknown';
    const nanohost = await updateNanoHost(
      target,
      nanoHostParams,
      path.join(evidenceDir, 'nanohost'),
      {
        ...componentIO,
        appUpdateObservation: async () => structuredClone(appEvidence),
      }
    );
    requireFact(
      nanohost.outcome === 'passed',
      'NanoHost did not establish its own successful result'
    );
    result.components.nanohost = { outcome: 'passed', reference: nanohost.reference };
    result.stage = 'worker';
    result.components.worker.outcome = 'unknown';
    const worker = await updateWorkerEnvironment(
      target,
      {
        ...common,
        ...p.worker,
        previousPhysicalEpoch: nanohost.before.physicalEpoch,
        nanoHostReplacementReference: nanohost.reference,
      },
      path.join(evidenceDir, 'worker'),
      {
        ...componentIO,
        archiveAttribution: async () => io.archiveAttribution('target'),
        replacementObservation: async () => structuredClone(nanohost),
      }
    );
    requireFact(
      worker.outcome === 'activated',
      'Worker did not establish its own activation result'
    );
    result.components.worker = {
      outcome: 'activated',
      prepareRequestId: worker.prepared.requestId,
      activationRequestId: worker.activation.requestId,
    };
    result.stage = 'complete';
    result.outcome = 'passed';
    return result;
  } catch (error) {
    result.reason =
      error instanceof ComponentUpdateStop
        ? error.message
        : `Component update: ${result.stage} incomplete or unavailable; inspect separate component evidence before any new effect.`;
    throw new ComponentUpdateStop(result.reason);
  } finally {
    await save(path.join(evidenceDir, 'components-result.json'), result);
  }
}
