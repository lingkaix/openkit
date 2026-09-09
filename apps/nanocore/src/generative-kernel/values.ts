import type { LightAppAdmittedCollection } from '@openkit/app-api-schemas';

import { KernelCommandError } from './errors.js';

const TEXT_BYTE_LIMIT = 4096;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Returns whether a date string is canonical millisecond UTC RFC3339.
 *
 * @param value Candidate date.
 * @returns True when the lexical form round-trips through Date.
 */
export function isCanonicalUtcDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * Checks one non-null field value against the admitted field contract.
 *
 * Relation existence is the caller's responsibility so import can use deferred foreign keys.
 *
 * @param field Admitted field.
 * @param value Caller value.
 * @returns Canonical JSON value.
 */
export function normalizeLightAppFieldValue(
  field: LightAppAdmittedCollection['fields'][number],
  value: unknown
): unknown {
  switch (field.type) {
    case 'text': {
      if (typeof value !== 'string') {
        throw new KernelCommandError('validation_failed', `Field ${field.name} must be text.`, {
          path: field.name,
        });
      }
      const max = (field.options as { max?: number } | undefined)?.max ?? TEXT_BYTE_LIMIT;
      if (Buffer.byteLength(value, 'utf8') > max) {
        throw new KernelCommandError('limit_exceeded', `Field ${field.name} exceeds text limit.`, {
          path: field.name,
          limit: 'textBytes',
          maximum: max,
        });
      }
      return value;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new KernelCommandError(
          'validation_failed',
          `Field ${field.name} must be a finite number.`,
          { path: field.name }
        );
      }
      const options =
        (field.options as { onlyInt?: boolean; min?: number; max?: number } | undefined) ?? {};
      if (options.onlyInt && !Number.isSafeInteger(value)) {
        throw new KernelCommandError(
          'validation_failed',
          `Field ${field.name} must be a safe integer.`,
          { path: field.name }
        );
      }
      if (options.min !== undefined && value < options.min) {
        throw new KernelCommandError('validation_failed', `Field ${field.name} is below minimum.`, {
          path: field.name,
        });
      }
      if (options.max !== undefined && value > options.max) {
        throw new KernelCommandError('validation_failed', `Field ${field.name} is above maximum.`, {
          path: field.name,
        });
      }
      return value;
    }
    case 'bool':
      if (typeof value !== 'boolean') {
        throw new KernelCommandError('validation_failed', `Field ${field.name} must be boolean.`, {
          path: field.name,
        });
      }
      return value;
    case 'date':
      if (typeof value !== 'string' || !isCanonicalUtcDate(value)) {
        throw new KernelCommandError(
          'validation_failed',
          `Field ${field.name} must be a canonical UTC date.`,
          { path: field.name }
        );
      }
      return value;
    case 'select': {
      const values = (field.options as { values: string[] }).values;
      if (typeof value !== 'string' || !values.includes(value)) {
        throw new KernelCommandError(
          'validation_failed',
          `Field ${field.name} must be an admitted select value.`,
          { path: field.name }
        );
      }
      return value;
    }
    case 'relation':
      if (typeof value !== 'string') {
        throw new KernelCommandError(
          'validation_failed',
          `Field ${field.name} must be a record id.`,
          { path: field.name }
        );
      }
      return value;
    default:
      throw new KernelCommandError(
        'validation_failed',
        `Unsupported field type for ${field.name}.`
      );
  }
}

/**
 * Encodes one canonical JSON field value as a SQLite bind parameter.
 *
 * @param type Field type.
 * @param value Canonical value.
 * @returns SQLite value.
 */
export function encodeSqlValue(type: string, value: unknown): unknown {
  if (value === null) {
    return null;
  }
  if (type === 'bool') {
    if (typeof value !== 'boolean') {
      throw new KernelCommandError('validation_failed', 'Boolean fields require a boolean value.');
    }
    return value === true ? 1 : 0;
  }
  return value;
}
