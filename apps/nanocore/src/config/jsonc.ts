import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser';

import { BootConfigError } from './mode.js';

/**
 * Parses a JSONC document into a plain object.
 *
 * @param source JSONC source text.
 * @param sourceName Human-readable source name for error messages.
 * @returns Plain object parsed from the JSONC document.
 * @throws BootConfigError when parsing fails or the document is not an object.
 */
export function parseJsoncObject(
  source: string,
  sourceName = 'JSONC input'
): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;

  if (errors.length > 0) {
    const message = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(', ');
    throw new BootConfigError('invalid_jsonc', `Invalid JSONC in ${sourceName}: ${message}.`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BootConfigError(
      'invalid_jsonc_object',
      `Invalid JSONC in ${sourceName}: expected an object.`
    );
  }

  return parsed as Record<string, unknown>;
}
