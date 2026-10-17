import { createHash } from 'node:crypto';
import { type LightAppSchemaInput, LightAppSchemaInputSchema } from '@openkit/app-api-schemas';
import {
  type CatalogProducer,
  type LightAppDefinitionEntryRecord,
  LightAppDefinitionEntryRecordSchema,
  type LightAppDefinitionPinRecord,
  LightAppDefinitionPinRecordSchema,
  type LightAppDefinitionVersionRecord,
  LightAppDefinitionVersionRecordSchema,
  type ResourceCatalogDocument,
  ResourceCatalogIdSchema,
  stableJson,
} from '@openkit/config-schema';
import { z } from 'zod';
import {
  CatalogConflictError,
  CatalogInputError,
  CatalogNotFoundError,
  loadWorkspaceResourceCatalog,
  publishWorkspaceResourceCatalog,
  readWorkspaceResourceCatalog,
  validateLightAppDefinitionCatalog,
} from './resource-catalog.js';

/** One exact definition and its immutable lineage, without business data or execution authority. */
export interface LightAppDefinitionExport {
  /** Exact export shape identity. */
  readonly schemaVersion: 1;
  /** Source entry; selection is historical on import. */
  readonly entry: LightAppDefinitionEntryRecord;
  /** Complete immutable definition history for this entry. */
  readonly versions: LightAppDefinitionVersionRecord[];
  /** Source pin, retained only as export provenance. */
  readonly pin: LightAppDefinitionPinRecord | null;
}

/** Workspace owner location for native template operations. */
interface CatalogScope {
  readonly dataRoot: string;
  readonly workspaceId: string;
}

/** Exact catalog identity within its Workspace. */
interface DefinitionScope extends CatalogScope {
  readonly entryId: string;
}

const DefinitionExportSchema = z
  .object({
    schemaVersion: z.literal(1),
    entry: LightAppDefinitionEntryRecordSchema,
    versions: z.array(LightAppDefinitionVersionRecordSchema),
    pin: LightAppDefinitionPinRecordSchema.nullable(),
  })
  .strict();

/**
 * Admits a strict declarative template in one existing catalog publication.
 * Identical bytes retain their first immutable actor, time and parent facts.
 *
 * @param input Exact definition, historical producer and optional future-use default selection.
 * @returns Published catalog and retained version.
 * @throws CatalogInputError, CatalogConflictError or CatalogNotFoundError before publication.
 */
export function importWorkspaceLightAppDefinition(
  input: DefinitionScope & {
    readonly expectedRevision: number;
    readonly displayName: string;
    readonly definition: LightAppSchemaInput;
    readonly parentDigest?: string | null;
    readonly producer: CatalogProducer;
    readonly createdAt: string;
    readonly selectDefault?: boolean;
  }
): { catalog: ResourceCatalogDocument; version: LightAppDefinitionVersionRecord } {
  const current = currentCatalog(input, input.expectedRevision);
  const id = inputValue(() => ResourceCatalogIdSchema.parse(input.entryId));
  const existing = current.lightApps.entries.find((entry) => entry.id === id);
  if (existing?.availability === 'removed')
    throw new CatalogNotFoundError(`Light App definition removed: ${id}`);
  const definitionJson = inputValue(() =>
    stableJson(LightAppSchemaInputSchema.parse(input.definition))
  );
  const digest = definitionDigest(definitionJson);
  const retained = current.lightApps.versions.find(
    (version) => version.entryId === id && version.digest === digest
  );
  const parentDigest =
    input.parentDigest === undefined ? (existing?.currentDigest ?? null) : input.parentDigest;
  if (
    parentDigest !== null &&
    !current.lightApps.versions.some(
      (version) => version.entryId === id && version.digest === parentDigest
    )
  ) {
    throw new CatalogNotFoundError(`Light App definition parent not found: ${id}/${parentDigest}`);
  }
  const version =
    retained ??
    inputValue(() =>
      LightAppDefinitionVersionRecordSchema.parse({
        createdAt: input.createdAt,
        definitionJson,
        digest,
        entryId: id,
        parentDigest,
        producer: input.producer,
      })
    );
  const entry = inputValue(() =>
    LightAppDefinitionEntryRecordSchema.parse({
      availability: 'available',
      currentDigest: input.selectDefault ? digest : (existing?.currentDigest ?? null),
      displayName: input.displayName,
      id,
    })
  );
  const catalog = publishWorkspaceResourceCatalog({
    ...input,
    catalog: {
      ...current,
      lightApps: {
        ...current.lightApps,
        entries: existing
          ? current.lightApps.entries.map((item) => (item.id === id ? { ...item, ...entry } : item))
          : [...current.lightApps.entries, entry],
        versions: retained ? current.lightApps.versions : [...current.lightApps.versions, version],
      },
    },
  });
  return {
    catalog,
    version: catalog.lightApps.versions.find(
      (item) => item.entryId === id && item.digest === digest
    )!,
  };
}

/** Lists definition identities and the exact catalog revision without reading business data. */
export function listWorkspaceLightAppDefinitions(input: CatalogScope): {
  revision: number;
  entries: LightAppDefinitionEntryRecord[];
} {
  const catalog = loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  return { revision: catalog.revision, entries: catalog.lightApps.entries };
}

/** Reads one definition entry, immutable history and its current future-use pin. */
export function readWorkspaceLightAppDefinition(
  input: DefinitionScope
): Omit<LightAppDefinitionExport, 'schemaVersion'> & { revision: number } {
  const catalog = loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  const entry = catalog.lightApps.entries.find((item) => item.id === input.entryId);
  if (!entry) throw new CatalogNotFoundError(`Light App definition not found: ${input.entryId}`);
  return {
    revision: catalog.revision,
    entry,
    versions: catalog.lightApps.versions.filter((version) => version.entryId === input.entryId),
    pin: catalog.lightApps.pins.find((pin) => pin.entryId === input.entryId) ?? null,
  };
}

/** Exports strict definition history and source selection as historical facts, with no live data. */
export function exportWorkspaceLightAppDefinition(
  input: DefinitionScope
): LightAppDefinitionExport {
  const { revision: _revision, ...definition } = readWorkspaceLightAppDefinition(input);
  return { schemaVersion: 1, ...definition };
}

/**
 * Imports verified history in one publication, optionally remapping only its catalog identity.
 * Source defaults and pins remain historical; existing target selection stays under its owner.
 *
 * @param input Exact exported history and optional explicit target catalog ID.
 * @returns Published catalog and target entry.
 * @throws CatalogInputError for invalid history without changing the existing catalog.
 */
export function importWorkspaceLightAppDefinitionHistory(
  input: CatalogScope & {
    readonly expectedRevision: number;
    readonly export: LightAppDefinitionExport;
    readonly entryId?: string;
  }
): { catalog: ResourceCatalogDocument; entry: LightAppDefinitionEntryRecord } {
  const current = currentCatalog(input, input.expectedRevision);
  const exported = inputValue(() => DefinitionExportSchema.parse(input.export));
  const source = {
    ...current,
    lightApps: {
      entries: [exported.entry],
      versions: exported.versions,
      pins: exported.pin ? [exported.pin] : [],
    },
  };
  inputValue(() => validateLightAppDefinitionCatalog(source));
  const id = inputValue(() => ResourceCatalogIdSchema.parse(input.entryId ?? exported.entry.id));
  const existing = current.lightApps.entries.find((entry) => entry.id === id);
  if (existing?.availability === 'removed')
    throw new CatalogNotFoundError(`Light App definition removed: ${id}`);
  const entry = existing ?? { ...exported.entry, id, currentDigest: null };
  const versions = [...current.lightApps.versions];
  for (const version of exported.versions) {
    if (!versions.some((retained) => retained.entryId === id && retained.digest === version.digest))
      versions.push({ ...version, entryId: id });
  }
  const catalog = publishWorkspaceResourceCatalog({
    ...input,
    catalog: {
      ...current,
      lightApps: {
        ...current.lightApps,
        entries: existing ? current.lightApps.entries : [...current.lightApps.entries, entry],
        versions,
      },
    },
  });
  return { catalog, entry: catalog.lightApps.entries.find((item) => item.id === id)! };
}

/** Selects an exact template default for a later explicit app create or activation. */
export function selectWorkspaceLightAppDefinitionDefault(
  input: DefinitionScope & {
    readonly expectedRevision: number;
    readonly digest: string;
    readonly expectedCurrentDigest?: string | null;
  }
): ResourceCatalogDocument {
  const current = currentCatalog(input, input.expectedRevision);
  const entry = requireVersion(current, input.entryId, input.digest).entry;
  if (
    Object.hasOwn(input, 'expectedCurrentDigest') &&
    entry.currentDigest !== input.expectedCurrentDigest
  )
    throw new CatalogConflictError('Light App definition default digest conflict.');
  return publishWorkspaceResourceCatalog({
    ...input,
    catalog: {
      ...current,
      lightApps: {
        ...current.lightApps,
        entries: current.lightApps.entries.map((item) =>
          item.id === input.entryId ? { ...item, currentDigest: input.digest } : item
        ),
      },
    },
  });
}

/** Sets or clears an exact template pin without changing any existing app. */
export function setWorkspaceLightAppDefinitionPin(
  input: DefinitionScope & {
    readonly expectedRevision: number;
    readonly digest: string | null;
    readonly expectedPinDigest?: string | null;
  }
): ResourceCatalogDocument {
  const current = currentCatalog(input, input.expectedRevision);
  if (!current.lightApps.entries.some((entry) => entry.id === input.entryId))
    throw new CatalogNotFoundError(`Light App definition not found: ${input.entryId}`);
  const prior = current.lightApps.pins.find((pin) => pin.entryId === input.entryId);
  if (
    Object.hasOwn(input, 'expectedPinDigest') &&
    (prior?.digest ?? null) !== input.expectedPinDigest
  )
    throw new CatalogConflictError('Light App definition pin digest conflict.');
  if (input.digest !== null) requireVersion(current, input.entryId, input.digest);
  const pins = current.lightApps.pins.filter((pin) => pin.entryId !== input.entryId);
  if (input.digest !== null) pins.push({ ...prior, entryId: input.entryId, digest: input.digest });
  return publishWorkspaceResourceCatalog({
    ...input,
    catalog: { ...current, lightApps: { ...current.lightApps, pins } },
  });
}

/** Resolves explicit digest, then pin, then default for one explicit future app operation. */
export function resolveWorkspaceLightAppDefinition(
  input: DefinitionScope & { readonly digest?: string }
): {
  version: LightAppDefinitionVersionRecord;
  definition: LightAppSchemaInput;
  selectionSource: 'explicit' | 'pin' | 'default';
} {
  const catalog = loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  const pin = catalog.lightApps.pins.find((item) => item.entryId === input.entryId);
  const digest =
    input.digest ??
    pin?.digest ??
    catalog.lightApps.entries.find((entry) => entry.id === input.entryId)?.currentDigest;
  if (!digest)
    throw new CatalogNotFoundError(
      `Light App definition has no selected version: ${input.entryId}`
    );
  const { version } = requireVersion(catalog, input.entryId, digest);
  return {
    version,
    definition: LightAppSchemaInputSchema.parse(JSON.parse(version.definitionJson)),
    selectionSource: input.digest !== undefined ? 'explicit' : pin ? 'pin' : 'default',
  };
}

/** Reads the same-owner view and checks the caller's inspected revision before mutation. */
function currentCatalog(input: CatalogScope, expectedRevision: number): ResourceCatalogDocument {
  const catalog = readWorkspaceResourceCatalog(input.dataRoot, input.workspaceId);
  if (catalog.revision !== expectedRevision) throw new CatalogConflictError();
  return catalog;
}

/** Requires available retained content under its unchanged catalog identity. */
function requireVersion(catalog: ResourceCatalogDocument, entryId: string, digest: string) {
  const entry = catalog.lightApps.entries.find((item) => item.id === entryId);
  const version = catalog.lightApps.versions.find(
    (item) => item.entryId === entryId && item.digest === digest
  );
  if (entry?.availability !== 'available' || !version)
    throw new CatalogNotFoundError(`Light App definition version not found: ${entryId}/${digest}`);
  return { entry, version };
}

/** Hashes the exact canonical UTF-8 template bytes, without including mutable catalog selection. */
function definitionDigest(definitionJson: string): string {
  return `sha256:${createHash('sha256').update(definitionJson, 'utf8').digest('hex')}`;
}

/** Converts refused request-derived values to the existing catalog input error. */
function inputValue<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new CatalogInputError(
      `Invalid Light App definition catalog input: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
