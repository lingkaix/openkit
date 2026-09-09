import { parseTree, type Node } from 'jsonc-parser';

import { KernelCommandError } from './errors.js';

/**
 * Parses one strict UTF-8 JSON object, rejecting comments and duplicate keys.
 *
 * @param text Candidate JSON text.
 * @returns Parsed object.
 */
export function parseStrictJsonObject(text: string): Record<string, unknown> {
  const errors: { error: number; offset: number; length: number }[] = [];
  const tree = parseTree(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (!tree || errors.length > 0 || tree.type !== 'object') {
    throw new KernelCommandError('validation_failed', 'Schema input must be a strict JSON object.');
  }
  assertNoDuplicateKeys(tree);
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new KernelCommandError('validation_failed', 'Schema input must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Recursively rejects duplicate property names in one JSONC object tree.
 *
 * @param node Parsed JSONC node.
 */
function assertNoDuplicateKeys(node: Node): void {
  if (node.type === 'object' && node.children) {
    const seen = new Set<string>();
    for (const child of node.children) {
      const name = child.children?.[0]?.value;
      if (typeof name === 'string') {
        if (seen.has(name)) {
          throw new KernelCommandError('validation_failed', `Duplicate JSON key: ${name}.`);
        }
        seen.add(name);
      }
      if (child.children?.[1]) {
        assertNoDuplicateKeys(child.children[1]);
      }
    }
    return;
  }
  if (node.type === 'array' && node.children) {
    for (const child of node.children) {
      assertNoDuplicateKeys(child);
    }
  }
}
