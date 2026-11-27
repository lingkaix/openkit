import {
  isProtectedNativeEnvironmentName,
  NativeEnvironmentValuesSchema,
} from '@openkit/worker-protocol';
import type { AgentManifest } from '../agents/manifest.js';
import type { CoreDb } from '../storage/db.js';
import { readNanoHostObservation } from '../storage/nanohost-observation-reader.js';
import type { AdmittedNanoHostTransportStorage } from '../storage/nanohost-transport-owner.js';
import { materializeRuntimeImage } from '../worker-environments/worker-environment-preparation.js';
import { DeterministicAgentPreparationError } from './agent-preparation-error.js';
import { commandInputHash } from './idempotent-command.js';
import { TurnStartValidationError } from './orchestrator.js';
import { readAdmittedWorkerImageEnvironment } from './worker-image-settlements-records.js';

/** Query-only access to the acknowledged NanoHost generation. */
export type NanoHostEnvironmentRead = AdmittedNanoHostTransportStorage['owner']['read'];

function readImageDefaults(sqlite: CoreDb['sqlite'], manifest: AgentManifest) {
  const image = materializeRuntimeImage(manifest.runtime.image);
  let imageDigest: string | null =
    image.kind === 'reference' && /^sha256:[0-9a-f]{64}$/.test(image.ref) ? image.ref : null;
  if (!imageDigest) {
    const rows = sqlite
      .prepare(
        `SELECT image_digest AS imageDigest FROM worker_image_settlements WHERE input_digest = ? AND outcome = 'success' AND native_environment_json IS NOT NULL`
      )
      .all(commandInputHash(image)) as { imageDigest: string }[];
    if (rows.length && rows.every((row) => row.imageDigest === rows[0]!.imageDigest))
      imageDigest = rows[0]!.imageDigest;
  }
  return imageDigest ? readAdmittedWorkerImageEnvironment({ sqlite }, imageDigest) : null;
}

/**
 * Resolves only exact confirmed image evidence before compatibility or lease admission.
 *
 * @throws TurnStartValidationError when the owner is unavailable or the image requires activation.
 * @throws DeterministicAgentPreparationError when authored settings conflict with protected or credential names, or the resolved map exceeds its bounds.
 */
export function resolvePublicNativeEnvironment(
  coreDb: CoreDb | undefined,
  manifest: AgentManifest,
  readNanoHostEnvironment?: NanoHostEnvironmentRead
) {
  const read = (sqlite: CoreDb['sqlite']) => readImageDefaults(sqlite, manifest);
  const admitted =
    readNanoHostEnvironment?.(read) ??
    (coreDb ? readNanoHostObservation(coreDb.dataRoot, read) : undefined);
  if (!admitted)
    throw new Error('Native environment resolution failed: Core storage is unavailable.');
  if (admitted.state === 'unavailable') {
    throw new TurnStartValidationError(
      'operation_storage_unavailable',
      'NanoHost environment storage is unavailable.',
      503
    );
  }
  const defaults = admitted.value;
  if (!defaults)
    throw new TurnStartValidationError(
      'worker_environment_preparation_required',
      `Agent "${manifest.id}" requires Worker environment preparation and activation before starting work; verified image defaults are unavailable.`,
      409
    );
  const protectedName = (name: string) =>
    isProtectedNativeEnvironmentName(name, manifest.runtime.adapter);
  const values = new Map(Object.entries(defaults.values).filter(([name]) => !protectedName(name)));
  const credentialNames = new Set(
    (manifest.sandbox?.credentialDeclarations ?? []).flatMap((declaration) =>
      declaration.visibility === 'runtime-env' && declaration.targetEnvVarName
        ? [declaration.targetEnvVarName]
        : []
    )
  );
  for (const [name, value] of Object.entries(manifest.runtime.environment ?? {})) {
    if (protectedName(name) || credentialNames.has(name))
      throw new DeterministicAgentPreparationError('Native environment authority conflict.');
    if (value === null) values.delete(name);
    else values.set(name, value);
  }
  if ([...values.keys()].some((name) => credentialNames.has(name)))
    throw new DeterministicAgentPreparationError('Native environment credential collision.');
  const resolvedValues = NativeEnvironmentValuesSchema.safeParse(Object.fromEntries(values));
  if (!resolvedValues.success) {
    throw new DeterministicAgentPreparationError('The native environment could not be prepared.');
  }
  return {
    imageDigest: defaults.imageDigest,
    defaultsDigest: defaults.defaultsDigest,
    values: resolvedValues.data,
  };
}
