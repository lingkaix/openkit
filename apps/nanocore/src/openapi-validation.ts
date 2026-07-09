import {
  hasSchema,
  registerSchema,
  setShouldValidateFormat,
  validate,
} from '@hyperjump/json-schema/draft-2020-12';

import type { JsonValue } from './openapi.js';

/** Validation result returned for one OpenAPI document check. */
export type OpenApiValidationErrors = string[];

/**
 * Validates one generated App API OpenAPI document against an OpenAPI JSON Schema.
 *
 * @param document OpenAPI document to validate.
 * @param schema OpenAPI JSON Schema document used as the validator source.
 * @returns Empty array when valid, otherwise product-safe validation messages.
 */
export async function validateAppOpenApiDocument(
  document: JsonValue,
  schema: JsonValue
): Promise<OpenApiValidationErrors> {
  const schemaObject = schema as Record<string, JsonValue>;
  const schemaId = schemaObject.$id;

  if (typeof schemaId !== 'string' || schemaId.length === 0) {
    return ['/ official OpenAPI schema is missing $id'];
  }

  setShouldValidateFormat(false);
  if (!hasSchema(schemaId)) {
    registerSchema(schemaObject, schemaId);
  }
  const output = await validate(schemaId, document, 'BASIC');

  if (output.valid) {
    return [];
  }

  return (output.errors ?? []).map((error) => `${error.instanceLocation} ${error.keyword}`);
}
