import { randomUUID } from 'node:crypto';

import {
  type LightAppAdmittedSchema,
  LightAppAdmittedSchemaSchema,
  type LightAppSchemaInput,
  LightAppSchemaInputSchema,
} from '@openkit/app-api-schemas';

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
  const candidate = typeof input === 'string' ? parseSchemaText(input) : input;
  const parsed = LightAppSchemaInputSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new KernelCommandError(
      'validation_failed',
      parsed.error.issues[0]?.message ?? 'Invalid Light App schema.'
    );
  }
  if (existing) {
    assertSafeSchemaEvolution(parsed.data, existing);
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
  return LightAppAdmittedSchemaSchema.parse({
    format: 'openkit.light-app',
    schemaVersion: 1,
    appId,
    schemaRevision,
    title: parsed.data.title,
    purpose: parsed.data.purpose,
    collections: admittedCollections,
  });
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
  existing: LightAppAdmittedSchema | undefined,
  kind: 'collection'
): string {
  const previous = existing?.collections.find(
    (collection) => collection.id === requestedId || collection.name === name
  );
  if (existing && !requestedId) {
    throw new KernelCommandError(
      'unsupported_operation',
      `Existing ${kind} IDs cannot be omitted.`
    );
  }
  if (requestedId) {
    if (existing && !existing.collections.some((collection) => collection.id === requestedId)) {
      throw new KernelCommandError('validation_failed', `Unknown ${kind} id.`);
    }
    return requestedId;
  }
  return previous?.id ?? randomUUID();
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
  existing: LightAppAdmittedSchema | undefined
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
    return randomUUID();
  }
  if (requestedId) {
    if (
      previousCollection &&
      !previousCollection.fields.some((field) => field.id === requestedId)
    ) {
      throw new KernelCommandError('validation_failed', 'Unknown field id.');
    }
    return requestedId;
  }
  const previous = previousCollection?.fields.find((field) => field.name === name);
  return previous?.id ?? randomUUID();
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
 * Enforces the initial evolution ceiling: rename, labels, and nullable scalar adds only.
 *
 * @param next Proposed schema.
 * @param existing Admitted schema.
 */
function assertSafeSchemaEvolution(
  next: LightAppSchemaInput,
  existing: LightAppAdmittedSchema
): void {
  if (next.collections.length < existing.collections.length) {
    throw new KernelCommandError('unsupported_operation', 'Removing collections is unavailable.');
  }
  for (const previous of existing.collections) {
    const match = next.collections.find((collection) => collection.id === previous.id);
    if (!match) {
      throw new KernelCommandError(
        'unsupported_operation',
        'Existing collection IDs cannot be omitted.'
      );
    }
    if (match.fields.length < previous.fields.length) {
      throw new KernelCommandError('unsupported_operation', 'Removing fields is unavailable.');
    }
    for (const previousField of previous.fields) {
      const nextField = match.fields.find((field) => field.id === previousField.id);
      if (!nextField) {
        throw new KernelCommandError(
          'unsupported_operation',
          'Existing field IDs cannot be omitted.'
        );
      }
      if (nextField.type !== previousField.type || nextField.required !== previousField.required) {
        throw new KernelCommandError(
          'unsupported_operation',
          'Changing field type or requiredness is unavailable.'
        );
      }
      if (
        JSON.stringify(nextField.options ?? null) !== JSON.stringify(previousField.options ?? null)
      ) {
        throw new KernelCommandError(
          'unsupported_operation',
          'Changing field options is unavailable.'
        );
      }
    }
    const fieldIds = new Map<string, string>();
    for (const field of previous.fields) {
      fieldIds.set(field.id, field.id);
      fieldIds.set(field.name, field.id);
    }
    for (const field of match.fields) {
      if (field.id) {
        fieldIds.set(field.id, field.id);
      }
      const resolved = field.id ?? fieldIds.get(field.name);
      if (resolved) {
        fieldIds.set(field.name, resolved);
      }
    }
    const indexKey = (index: { unique?: boolean; fields: readonly string[] }): string =>
      JSON.stringify({
        unique: Boolean(index.unique),
        fields: index.fields.map((selector) => fieldIds.get(selector) ?? selector),
      });
    const previousKeys = previous.indexes.map(indexKey).sort();
    const nextKeys = match.indexes.map(indexKey).sort();
    if (JSON.stringify(previousKeys) !== JSON.stringify(nextKeys)) {
      throw new KernelCommandError('unsupported_operation', 'Changing indexes is unavailable.');
    }
    for (const nextField of match.fields) {
      if (nextField.id) {
        continue;
      }
      if (nextField.required || nextField.type === 'relation') {
        throw new KernelCommandError(
          'unsupported_operation',
          'Initial evolution only permits adding nullable scalar fields.'
        );
      }
    }
  }
}
