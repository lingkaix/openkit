import { isDeepStrictEqual } from 'node:util';
import {
  type LightAppAdmittedSchema,
  LightAppAdmittedSchemaSchema,
  type LightAppSchemaInput,
  LightAppSchemaInputSchema,
} from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';

import { KernelCommandError } from './errors.js';
import { parseStrictJsonObject } from './json.js';

const SCHEMA_BYTE_LIMIT = 256 * 1024;

/**
 * Parses and admits one Light App schema proposal, assigning IDs and resolving selectors.
 *
 * @param input Schema object or UTF-8 JSON text.
 * @param appId Owning app UUID.
 * @param schemaRevision Positive admitted schema revision.
 * @param existing Previously admitted schema when updating.
 * @returns Canonical admitted schema document.
 */
export function admitLightAppSchema(
  input: unknown,
  appId: string,
  schemaRevision: number,
  existing?: LightAppAdmittedSchema
): LightAppAdmittedSchema {
  const definition = admitLightAppDefinition(input, existing);
  return LightAppAdmittedSchemaSchema.parse({ ...definition, appId, schemaRevision });
}

/**
 * Admits a reusable definition with stable collection and field IDs, without app identity.
 *
 * @param input Authored definition object or JSON text.
 * @param existingDefinition Prior exact admitted definition for supported evolution.
 * @returns Normalized reusable definition with resolved selectors and stable IDs.
 */
export function admitLightAppDefinition(
  input: unknown,
  existingDefinition?: LightAppSchemaInput
): LightAppSchemaInput {
  const existing = existingDefinition;
  const candidate = typeof input === 'string' ? parseSchemaText(input) : input;
  const encoded = JSON.stringify(candidate);
  if (Buffer.byteLength(encoded, 'utf8') > SCHEMA_BYTE_LIMIT) {
    throw new KernelCommandError('limit_exceeded', 'Schema exceeds 256 KiB.', {
      limit: 'schemaBytes',
      maximum: SCHEMA_BYTE_LIMIT,
    });
  }
  const parsed = LightAppSchemaInputSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new KernelCommandError(
      'validation_failed',
      parsed.error.issues[0]?.message ?? 'Invalid Light App schema.'
    );
  }
  const collectionIds = new Map<string, string>();
  const collections = parsed.data.collections.map((collection) => {
    const collectionId = resolveEntityId(collection.id, collection.name, existing, 'collection');
    collectionIds.set(collection.name, collectionId);
    collectionIds.set(collectionId, collectionId);
    return { collection, collectionId };
  });
  const admittedCollections = collections.map(({ collection, collectionId }) => {
    const fieldIds = new Map<string, string>();
    const fields = collection.fields.map((field) => {
      const fieldId = resolveFieldId(field.id, field.name, collectionId, existing);
      fieldIds.set(field.name, fieldId);
      fieldIds.set(fieldId, fieldId);
      const options =
        field.type === 'relation'
          ? {
              collection: resolveSelector(
                (field.options as { collection: string }).collection,
                collectionIds,
                'relation collection'
              ),
            }
          : field.options;
      return {
        id: fieldId,
        name: field.name,
        type: field.type,
        required: field.required,
        description: field.description,
        ...(field.unit ? { unit: field.unit } : {}),
        ...(field.namespace ? { namespace: field.namespace } : {}),
        ...(options ? { options } : {}),
      };
    });
    return {
      id: collectionId,
      name: collection.name,
      type: 'base' as const,
      description: collection.description,
      fields,
      indexes: collection.indexes.map((index) => ({
        unique: index.unique,
        fields: index.fields.map((selector) => resolveSelector(selector, fieldIds, 'index field')),
      })),
    };
  });
  const admitted = LightAppSchemaInputSchema.parse({
    format: 'openkit.light-app',
    schemaVersion: 1,
    title: parsed.data.title,
    purpose: parsed.data.purpose,
    references: parsed.data.references ?? [],
    collections: admittedCollections,
  });
  if (existing) {
    assertSafeSchemaEvolution(admitted, existing);
  }
  return admitted;
}

/**
 * Parses schema text under the initial size bound.
 *
 * @param text UTF-8 schema JSON.
 * @returns Parsed object.
 */
function parseSchemaText(text: string): Record<string, unknown> {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > SCHEMA_BYTE_LIMIT) {
    throw new KernelCommandError('limit_exceeded', 'Schema exceeds 256 KiB.', {
      limit: 'schemaBytes',
      maximum: SCHEMA_BYTE_LIMIT,
    });
  }
  return parseStrictJsonObject(text);
}

/**
 * Resolves a collection identity, forbidding omitted existing IDs that would drop-and-add.
 *
 * @param requestedId Optional caller-supplied id.
 * @param name Current collection name.
 * @param existing Previously admitted schema.
 * @param kind Entity kind for error text.
 * @returns Stable UUID.
 */
function resolveEntityId(
  requestedId: string | undefined,
  name: string,
  existing: LightAppSchemaInput | undefined,
  kind: 'collection'
): string {
  const previous = existing?.collections.find(
    (collection) => collection.id === requestedId || collection.name === name
  );
  if (previous && !requestedId) {
    throw new KernelCommandError(
      'unsupported_operation',
      `Existing ${kind} IDs cannot be omitted.`
    );
  }
  if (requestedId) {
    return requestedId;
  }
  return previous?.id ?? allocateEntityId('col');
}

/**
 * Resolves a field identity against one existing collection.
 *
 * @param requestedId Optional caller-supplied id.
 * @param name Current field name.
 * @param collectionId Parent collection id.
 * @param existing Previously admitted schema.
 * @returns Stable UUID.
 */
function resolveFieldId(
  requestedId: string | undefined,
  name: string,
  collectionId: string,
  existing: LightAppSchemaInput | undefined
): string {
  const previousCollection = existing?.collections.find(
    (collection) => collection.id === collectionId
  );
  if (existing && previousCollection && !requestedId) {
    const previous = previousCollection.fields.find((field) => field.name === name);
    if (previous) {
      throw new KernelCommandError(
        'unsupported_operation',
        'Existing field IDs cannot be omitted.'
      );
    }
    return allocateEntityId('fld');
  }
  if (requestedId) {
    return requestedId;
  }
  const previous = previousCollection?.fields.find((field) => field.name === name);
  return previous?.id ?? allocateEntityId('fld');
}

/**
 * Resolves a name or ID selector against an allocated identity map.
 *
 * @param selector Name or UUID.
 * @param ids Map of names and IDs to stable IDs.
 * @param label Error label.
 * @returns Stable UUID.
 */
function resolveSelector(selector: string, ids: Map<string, string>, label: string): string {
  const resolved = ids.get(selector);
  if (!resolved) {
    throw new KernelCommandError('validation_failed', `Unknown ${label} selector: ${selector}.`);
  }
  return resolved;
}

/**
 * Permits collection additions, optional fields, logical renames, and field removal.
 *
 * Surviving field constraints and indexes remain unchanged.
 * Admission resolves all selectors before this check, so deleted fields cannot leave dangling indexes.
 *
 * @param next Resolved proposed schema.
 * @param existing Admitted schema.
 */
function assertSafeSchemaEvolution(next: LightAppSchemaInput, existing: LightAppSchemaInput): void {
  for (const previous of existing.collections) {
    const match = next.collections.find((collection) => collection.id === previous.id);
    if (!match) {
      throw new KernelCommandError('unsupported_operation', 'Removing collections is unavailable.');
    }
    const survivingIds = new Set(match.fields.map((field) => field.id));
    for (const previousField of previous.fields) {
      const nextField = match.fields.find((field) => field.id === previousField.id);
      if (!nextField) continue;
      if (nextField.type !== previousField.type || nextField.required !== previousField.required) {
        throw new KernelCommandError(
          'unsupported_operation',
          'Changing field type or requiredness is unavailable.'
        );
      }
      if (!isDeepStrictEqual(nextField.options ?? null, previousField.options ?? null)) {
        throw new KernelCommandError(
          'unsupported_operation',
          'Changing field options is unavailable.'
        );
      }
    }
    const indexKey = (index: { unique: boolean; fields: readonly string[] }): string =>
      JSON.stringify(index);
    const previousKeys = previous.indexes
      .filter((index) => index.fields.every((id) => survivingIds.has(id)))
      .map(indexKey)
      .sort();
    const nextKeys = match.indexes.map(indexKey).sort();
    if (!isDeepStrictEqual(previousKeys, nextKeys)) {
      throw new KernelCommandError(
        'unsupported_operation',
        'Surviving indexes cannot change; removing a field removes only its dependent indexes.'
      );
    }
    for (const field of match.fields) {
      if (!previous.fields.some((prior) => prior.id === field.id) && field.required) {
        throw new KernelCommandError('unsupported_operation', 'New fields must be optional.');
      }
    }
  }
}
