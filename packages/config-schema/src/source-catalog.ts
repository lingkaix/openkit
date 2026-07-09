import { createHash } from 'node:crypto';
import { z } from 'zod';

import { isRegisteredRequiredFeature } from './schema-evolution.js';
import { WorkspaceSlotKindSchema } from './session-workspace.js';

const SECRET_LIKE_FIELD_NAMES = new Set([
  'apiKey',
  'authorization',
  'clientSecret',
  'password',
  'secret',
  'token',
]);

/** Workspace data source kind vocabulary. */
export const WorkspaceDataSourceKindSchema = z.enum([
  'git',
  'workspace-file',
  'workspace-dir',
  's3',
  'r2',
  'gcs',
  'azure-blob',
  'box',
  's3-files',
  'http-archive',
  'openkit-artifact',
]);

/** Maximum access class permitted by a workspace data source. */
export const WorkspaceDataSourceAccessSchema = z.enum(['read-only', 'read-write']);

/** Workspace data source sensitivity class. */
export const WorkspaceDataSourceSensitivitySchema = z.enum([
  'public',
  'internal',
  'confidential',
  'restricted',
]);

/** Non-secret locator for one workspace data source. */
export const WorkspaceDataSourceLocatorSchema = z
  .record(z.string().min(1), z.unknown())
  .superRefine((value, ctx) => {
    if (hasSecretLikeLocatorField(value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Workspace data source locators must not contain secret-like fields.',
      });
    }

    if (hasUrlCredential(value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Workspace data source locator URLs must not embed credentials.',
      });
    }
  });

/** Workspace-owned data source record. */
export const WorkspaceDataSourceSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9._-]+$/),
    kind: WorkspaceDataSourceKindSchema,
    displayName: z.string().min(1),
    locator: WorkspaceDataSourceLocatorSchema,
    access: WorkspaceDataSourceAccessSchema,
    sensitivity: WorkspaceDataSourceSensitivitySchema,
    vaultGrantRef: z.string().min(1).optional(),
    allowedSlotKinds: z.array(WorkspaceSlotKindSchema).min(1),
    syncHints: z.record(z.string().min(1), z.unknown()).default({}),
    status: z.enum(['active', 'disabled']),
    requiredFeatures: z.array(z.string().min(1)).default([]),
    extensions: z.record(z.string().min(1), z.unknown()).default({}),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const [index, feature] of value.requiredFeatures.entries()) {
      if (!isRegisteredRequiredFeature(feature)) {
        ctx.addIssue({
          code: 'custom',
          message: `Unregistered required feature: ${feature}`,
          path: ['requiredFeatures', index],
        });
      }
    }
  });

/** Workspace-owned data source catalog. */
export const WorkspaceDataSourceCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    requiredFeatures: z.array(z.string().min(1)).default([]),
    sources: z.array(WorkspaceDataSourceSchema).default([]),
    extensions: z.record(z.string().min(1), z.unknown()).default({}),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();

    for (const [index, feature] of value.requiredFeatures.entries()) {
      if (!isRegisteredRequiredFeature(feature)) {
        ctx.addIssue({
          code: 'custom',
          message: `Unregistered required feature: ${feature}`,
          path: ['requiredFeatures', index],
        });
      }
    }

    for (const [index, source] of value.sources.entries()) {
      if (ids.has(source.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate workspace data source id: ${source.id}.`,
          path: ['sources', index, 'id'],
        });
      }

      ids.add(source.id);
    }
  });

/** Parsed workspace data source kind. */
export type WorkspaceDataSourceKind = z.infer<typeof WorkspaceDataSourceKindSchema>;
/** Parsed workspace data source access class. */
export type WorkspaceDataSourceAccess = z.infer<typeof WorkspaceDataSourceAccessSchema>;
/** Parsed workspace data source sensitivity. */
export type WorkspaceDataSourceSensitivity = z.infer<typeof WorkspaceDataSourceSensitivitySchema>;
/** Parsed workspace data source record. */
export type WorkspaceDataSource = z.infer<typeof WorkspaceDataSourceSchema>;
/** Parsed workspace data source catalog. */
export type WorkspaceDataSourceCatalog = z.infer<typeof WorkspaceDataSourceCatalogSchema>;
/** Parsed worker-visible workspace slot kind. */
export type WorkspaceDataSourceSlotKind = z.infer<typeof WorkspaceSlotKindSchema>;

/** Parse options for workspace data source catalogs. */
export interface ParseWorkspaceDataSourceCatalogOptions {
  /** Feature ids supported by the caller. */
  supportedFeatures?: readonly string[];
}

/** Input for resolving one manifest source reference against a workspace catalog. */
export interface ResolveWorkspaceDataSourceReferenceInput {
  /** Parsed workspace data source catalog. */
  catalog: WorkspaceDataSourceCatalog;
  /** Source id referenced by the manifest or runtime launch input. */
  sourceRef: string;
  /** Access requested for this launch input. */
  access: WorkspaceDataSourceAccess;
  /** Slot kind selected for the resolved input. */
  slotKind: WorkspaceDataSourceSlotKind;
}

/** Catalog-backed source snapshot attached to resolved launch state. */
export interface ResolvedWorkspaceDataSourceReference {
  /** Stable workspace source id. */
  sourceId: string;
  /** Source kind resolved from the catalog. */
  sourceKind: WorkspaceDataSourceKind;
  /** Non-secret source locator resolved from the catalog. */
  locator: WorkspaceDataSource['locator'];
  /** Access granted to this launch input. */
  access: WorkspaceDataSourceAccess;
  /** Source sensitivity class. */
  sensitivity: WorkspaceDataSourceSensitivity;
  /** Optional vault grant reference required to use the source. */
  vaultGrantRef?: string;
  /** Stable digest of the resolved catalog entry. */
  catalogEntryDigest: string;
}

/**
 * Parses a workspace data source catalog and fails closed for unsupported required features.
 *
 * @param input Raw workspace data source catalog candidate.
 * @param options Supported required-feature ids.
 * @returns Parsed workspace data source catalog with unknown optional fields preserved.
 * @throws Error when the catalog is invalid or requires unsupported features.
 */
export function parseWorkspaceDataSourceCatalog(
  input: unknown,
  options: ParseWorkspaceDataSourceCatalogOptions = {}
): WorkspaceDataSourceCatalog {
  const parsed = WorkspaceDataSourceCatalogSchema.parse(input);
  const supportedFeatures = new Set(options.supportedFeatures ?? []);

  for (const feature of collectRequiredFeatures(parsed)) {
    if (!supportedFeatures.has(feature)) {
      throw new Error(`Unsupported required feature: ${feature}`);
    }
  }

  return parsed;
}

/**
 * Resolves one source reference against a workspace catalog and fails closed on unsafe use.
 *
 * @param input Catalog, source ref, requested access, and selected slot kind.
 * @returns Immutable source snapshot suitable for launch-state lineage.
 * @throws Error when the source is missing, disabled, slot-denied, or access-denied.
 */
export function resolveWorkspaceDataSourceReference(
  input: ResolveWorkspaceDataSourceReferenceInput
): ResolvedWorkspaceDataSourceReference {
  const source = input.catalog.sources.find((candidate) => candidate.id === input.sourceRef);

  if (!source) {
    throw new Error(`Workspace data source not found: ${input.sourceRef}`);
  }

  if (source.status !== 'active') {
    throw new Error(`Workspace data source disabled: ${input.sourceRef}`);
  }

  if (!source.allowedSlotKinds.includes(input.slotKind)) {
    throw new Error(`Workspace data source slot denied: ${input.sourceRef}`);
  }

  if (source.access === 'read-only' && input.access === 'read-write') {
    throw new Error(`Workspace data source access denied: ${input.sourceRef}`);
  }

  return {
    access: input.access,
    catalogEntryDigest: `sha256:${createHash('sha256').update(stableJson(source)).digest('hex')}`,
    locator: source.locator,
    sensitivity: source.sensitivity,
    sourceId: source.id,
    sourceKind: source.kind,
    ...(source.vaultGrantRef ? { vaultGrantRef: source.vaultGrantRef } : {}),
  };
}

/**
 * Collects catalog-level and source-level required features.
 *
 * @param catalog Parsed catalog.
 * @returns Unique required-feature ids.
 */
function collectRequiredFeatures(catalog: WorkspaceDataSourceCatalog): string[] {
  return [
    ...new Set([
      ...catalog.requiredFeatures,
      ...catalog.sources.flatMap((source) => source.requiredFeatures),
    ]),
  ];
}

/**
 * Stringifies values with stable object-key ordering.
 *
 * @param value Value to stringify.
 * @returns Deterministic JSON string.
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

/**
 * Checks whether a locator object contains a secret-like field name.
 *
 * @param value Locator subtree.
 * @returns True when a secret-like key is present.
 */
function hasSecretLikeLocatorField(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(hasSecretLikeLocatorField);
  }

  for (const [key, child] of Object.entries(value)) {
    if (SECRET_LIKE_FIELD_NAMES.has(key)) {
      return true;
    }

    if (hasSecretLikeLocatorField(child)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether any locator URL embeds username/password credentials.
 *
 * @param value Locator subtree.
 * @returns True when a URL value contains credentials.
 */
function hasUrlCredential(value: unknown): boolean {
  if (typeof value === 'string') {
    try {
      const url = new URL(value);
      return Boolean(url.username || url.password);
    } catch {
      return false;
    }
  }

  if (!value || typeof value !== 'object') {
    return false;
  }

  return Object.values(value).some(hasUrlCredential);
}
