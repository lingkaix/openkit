import { VaultGrantIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Captured setup feature identifiers are evidence of the original resolution, not current readiness. */
export const StoredSetupRequiredFeaturesV1Schema = z.array(z.string());

const StoredSetupImageV1Schema = z.discriminatedUnion('kind', [
  z.object({
    arguments: z.never().optional(),
    contextDigest: z.never().optional(),
    contextRef: z.never().optional(),
    egress: z.never().optional(),
    input: z.never().optional(),
    layerLimit: z.never().optional(),
    outputLimitBytes: z.never().optional(),
    timeLimitSeconds: z.never().optional(),
    kind: z.literal('reference'),
    pullPolicy: z.enum(['always', 'if-not-present', 'never']),
    ref: z.string().min(1),
  }),
  z.object({
    arguments: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
    contextDigest: z.literal(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    ),
    contextRef: z.literal('build-context://empty/v1'),
    egress: z.array(
      z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535) })
    ),
    input: z.object({
      content: z.string(),
      digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      kind: z.literal('dockerfile'),
    }),
    kind: z.literal('build'),
    pullPolicy: z.never().optional(),
    ref: z.never().optional(),
    layerLimit: z.number().int().min(1).max(128),
    outputLimitBytes: z.number().int().min(1).max(21_474_836_480),
    timeLimitSeconds: z.number().int().min(1).max(1800),
  }),
]);

const credentialMetadata = {
  id: z.string().min(1),
  requirementId: z.string().min(1).optional(),
  vaultGrantId: VaultGrantIdSchema,
};
const StoredSetupCredentialMetadataV1Schema = z.discriminatedUnion('visibility', [
  z.object({
    ...credentialMetadata,
    visibility: z.literal('sandbox-provider'),
    provider: z.object({
      credentialKey: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      instanceId: z.string().min(1),
      profileId: z.string().min(1),
      type: z.string().min(1),
    }),
  }),
  z.object({
    ...credentialMetadata,
    targetPath: z.string().min(1),
    visibility: z.literal('runtime-file'),
  }),
  z.object({
    ...credentialMetadata,
    targetEnvVarName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    visibility: z.literal('runtime-env'),
  }),
]);

const networkMetadata = {
  binaries: z.array(z.string()),
  host: z.string().min(1),
  allowEncodedSlash: z.boolean().optional(),
  id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/),
  port: z.number().int().min(1).max(65535),
  purpose: z.string().min(1),
  scope: z.enum(['session', 'reusable']),
};
const StoredSetupNetworkMetadataV1Schema = z.union([
  z.object({
    ...networkMetadata,
    access: z.enum(['read-only', 'read-write']),
    protocol: z.enum(['rest', 'http', 'https']),
    rules: z.never().optional(),
  }),
  z.object({
    ...networkMetadata,
    access: z.never().optional(),
    protocol: z.literal('rest'),
    rules: z
      .array(
        z.object({
          method: z.enum(['GET', 'POST']),
          path: z
            .string()
            .min(1)
            .startsWith('/')
            .refine((path) => !/[\r\n]/.test(path)),
        })
      )
      .min(1),
  }),
]);

/** Fixed whitelisted v1 evidence; decoding supplies no live launch, credential or network authority. */
export const StoredResolvedAgentSetupV1Schema = z.object({
  manifest: z.object({
    id: z.string().min(1),
    requiredFeatures: StoredSetupRequiredFeaturesV1Schema,
    runtime: z.object({
      adapter: z.string().min(1),
      binaries: z.array(z.object({ id: z.string().min(1), path: z.string().min(1) })),
      image: StoredSetupImageV1Schema,
      kind: z.string().min(1),
      version: z.string().min(1).optional(),
    }),
    sandbox: z.object({
      credentialDeclarations: z.array(StoredSetupCredentialMetadataV1Schema),
      network: z.array(StoredSetupNetworkMetadataV1Schema),
    }),
  }),
  logicalModels: z.object({
    preferredLogicalModelId: z.string().min(1),
    allowed: z.array(
      z.object({
        id: z.string().min(1),
        capabilities: z.array(z.string()),
        modelFamilyId: z.string().nullable(),
      })
    ),
  }),
});
