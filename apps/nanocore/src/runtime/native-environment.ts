import {
  isProtectedNativeEnvironmentName,
  NativeEnvironmentValuesSchema,
} from '@openkit/worker-protocol';
import type { AgentManifest } from '../agents/manifest.js';
import type { CoreDb } from '../storage/db.js';
import { materializeRuntimeImage } from '../worker-environments/worker-environment-preparation.js';
import { commandInputHash } from './idempotent-command.js';
import { readAdmittedWorkerImageEnvironment } from './worker-image-settlements.js';

/** Resolves only exact confirmed image evidence before compatibility or lease admission. */
export function resolvePublicNativeEnvironment(
  coreDb: CoreDb | undefined,
  manifest: AgentManifest
) {
  if (!coreDb)
    throw new Error(
      'Native environment preparation-required: verified image defaults are unavailable.'
    );
  const image = materializeRuntimeImage(manifest.runtime.image);
  let imageDigest: string | null =
    image.kind === 'reference' && /^sha256:[0-9a-f]{64}$/.test(image.ref) ? image.ref : null;
  if (!imageDigest) {
    const rows = coreDb.sqlite
      .prepare(
        `SELECT image_digest AS imageDigest FROM worker_image_settlements WHERE input_digest = ? AND outcome = 'success' AND native_environment_json IS NOT NULL`
      )
      .all(commandInputHash(image)) as { imageDigest: string }[];
    if (rows.length && rows.every((row) => row.imageDigest === rows[0]!.imageDigest))
      imageDigest = rows[0]!.imageDigest;
  }
  const defaults = imageDigest ? readAdmittedWorkerImageEnvironment(coreDb, imageDigest) : null;
  if (!defaults)
    throw new Error(
      'Native environment preparation-required: verified image defaults are unavailable.'
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
      throw new Error('Native environment authority conflict.');
    if (value === null) values.delete(name);
    else values.set(name, value);
  }
  if ([...values.keys()].some((name) => credentialNames.has(name)))
    throw new Error('Native environment credential collision.');
  return {
    imageDigest: defaults.imageDigest,
    defaultsDigest: defaults.defaultsDigest,
    values: NativeEnvironmentValuesSchema.parse(Object.fromEntries(values)),
  };
}
