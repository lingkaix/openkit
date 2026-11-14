import { isDeepStrictEqual } from 'node:util';
import type { AgentEnvironmentPackage, GatewayConfig } from '@openkit/config-schema';
import { isEntityId } from '@openkit/protocol';
import { z } from 'zod';
import { WorkerSandboxPolicyIntentSchema } from './worker-governance-backend.js';

/** Bounded opaque correlation; none of these strings can supply credential material. */
const identity = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) =>
    [...value].every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
  );
const digest = z.string().regex(/^[0-9a-f]{64}$/);

/** Transient projection of a configuration-owned static bearer access shape. */
export const WorkerProviderAccessShapeSchema = z
  .object({
    id: identity,
    credentialKey: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .refine((key) => !/^v\d+_/.test(key)),
    endpoints: WorkerSandboxPolicyIntentSchema.shape.additionalNetworkEndpoints.min(1),
  })
  .strict()
  .superRefine((shape, context) => {
    // The stock profile has one binary set for all endpoints. Never widen a per-endpoint grant.
    const binaries = [...new Set(shape.endpoints[0]!.binaries)].sort();
    for (const [index, endpoint] of shape.endpoints.entries()) {
      if (!isDeepStrictEqual([...new Set(endpoint.binaries)].sort(), binaries)) {
        context.addIssue({
          code: 'custom',
          message: 'Provider endpoints require the same binary authority.',
          path: ['endpoints', index, 'binaries'],
        });
      }
    }
  });

/** Configuration data crosses the backend port as intent, not as a native profile. */
export type WorkerProviderAccessShape = z.infer<typeof WorkerProviderAccessShapeSchema>;

/** Reads only explicit current configuration data; absent/ambiguous/invalid intent refuses. */
export function readConfiguredWorkerProviderAccessShape(
  configuration: Pick<GatewayConfig, 'providerAccessShapes'> | undefined,
  profileId: string
): WorkerProviderAccessShape | undefined {
  const selected = configuration?.providerAccessShapes?.filter((shape) => shape.id === profileId);
  if (!selected || selected.length !== 1) return undefined;
  const parsed = WorkerProviderAccessShapeSchema.safeParse(selected[0]);
  return parsed.success ? parsed.data : undefined;
}

/** Reference-only preparation; actual material is resolved by the governed binding operation. */
export const WorkerProviderCredentialBindingSchema = z
  .object({
    declarationId: identity,
    grantId: identity.refine((value) => isEntityId('grant', value)),
    planId: identity,
    receiptId: identity,
    vaultReferenceId: identity.refine((value) => isEntityId('vault', value)),
    materialVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    providerInstanceId: identity,
    providerType: identity,
    credentialKey: identity,
    profileId: identity,
    accessShape: WorkerProviderAccessShapeSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.profileId === value.accessShape.id &&
      value.credentialKey === value.accessShape.credentialKey
  );

/** One exact prepared binding on the existing live session owner. */
export type WorkerProviderCredentialBinding = z.infer<typeof WorkerProviderCredentialBindingSchema>;

/** The current configuration owner supplies the same shape; an absent reader refuses any binding. */
export type WorkerProviderAccessShapeReader = (
  profileId: string
) => WorkerProviderAccessShape | undefined;

/** Closed private metadata for the existing reference.import file-data carriage. */
export const WorkerProviderEffectIntentSchema = WorkerProviderCredentialBindingSchema.safeExtend({
  deploymentId: identity,
  workspaceId: identity,
  policyIntent: WorkerSandboxPolicyIntentSchema,
  expectedReceiptId: identity.optional(),
  expiresAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

/** Native projection facts are evidence; they never authorize another delivery. */
export const WorkerProviderProtectionProofSchema = z
  .object({
    declarationId: identity,
    grantId: identity,
    planId: identity,
    receiptId: identity,
    vaultReferenceId: identity,
    materialVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    mappingVersion: z.literal(1),
    profileDigest: digest,
    expectedPolicyDigest: digest,
    observedPolicyDigest: digest,
    placeholderOnly: z.literal(true),
    exposure: z.literal('sandbox-provider'),
  })
  .strict()
  .refine((proof) => proof.expectedPolicyDigest === proof.observedPolicyDigest);

/** Completed placement proof, still subject to current Core authority and canonical acceptance. */
export type WorkerProviderProtectionProof = z.infer<typeof WorkerProviderProtectionProofSchema>;

/** Validates untrusted preparation without resolving any credential or permitting an effect. */
export function requireWorkerProviderBindings(
  environmentPackage: AgentEnvironmentPackage,
  inputs: readonly unknown[],
  readShape?: WorkerProviderAccessShapeReader
): WorkerProviderCredentialBinding[] {
  const declarations = environmentPackage.credentials.declarations.filter(
    (value) => value.visibility === 'sandbox-provider'
  );
  const bindings = inputs.map((input) => WorkerProviderCredentialBindingSchema.parse(input));
  const identities = new Set<string>();
  if (bindings.length !== declarations.length)
    throw new Error('Admitted Provider supply is unavailable.');
  for (const binding of bindings) {
    const declaration = declarations.find((value) => value.id === binding.declarationId);
    if (
      !declaration ||
      declaration.visibility !== 'sandbox-provider' ||
      declaration.vaultGrantId !== binding.grantId ||
      declaration.provider.instanceId !== binding.providerInstanceId ||
      declaration.provider.type !== binding.providerType ||
      declaration.provider.credentialKey !== binding.credentialKey ||
      declaration.provider.profileId !== binding.profileId ||
      identities.has(binding.declarationId)
    )
      throw new Error('Admitted Provider supply is unavailable.');
    identities.add(binding.declarationId);
    if (!readShape) throw new Error('Provider access shape is unavailable.');
    const current = WorkerProviderAccessShapeSchema.safeParse(readShape(binding.profileId));
    if (!current.success || !isDeepStrictEqual(current.data, binding.accessShape))
      throw new Error('Provider access shape changed.');
  }
  return bindings;
}

/** Rejects missing, unknown or unrelated native completion before any receipt is published. */
export function requireWorkerProviderProtection(
  binding: WorkerProviderCredentialBinding,
  candidate: unknown
): WorkerProviderProtectionProof {
  const proof = WorkerProviderProtectionProofSchema.parse(candidate);
  for (const key of [
    'declarationId',
    'grantId',
    'planId',
    'receiptId',
    'vaultReferenceId',
    'materialVersion',
  ] as const) {
    if (proof[key] !== binding[key])
      throw new Error('Provider protection does not match its admitted binding.');
  }
  return proof;
}

/** Descriptive evidence stays in the existing receipt/Audit summary, not a new retained field. */
export function workerProviderBackendSummary(proof: WorkerProviderProtectionProof): string {
  return `static-provider mapping=${proof.mappingVersion} profile=${proof.profileDigest} expected=${proof.expectedPolicyDigest} observed=${proof.observedPolicyDigest} exposure=sandbox-provider`;
}
