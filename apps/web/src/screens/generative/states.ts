/**
 * Three-state A2UI render model (DESIGN.md §10.8, D-011).
 *
 * No dead ends: streaming skeleton → rendered (whitelist) → plain-content fallback.
 * An unknown component degrades to content; never an error card or embedded frame.
 */

import type { A2UIDocument } from './catalog';
import { isWhitelisted } from './catalog';

/** In-thread generative surface presentation state. */
export type GenerativeRenderState = 'streaming' | 'ready' | 'fallback';

/**
 * Walks a declarative A2UI tree and returns true when any node type is outside
 * the OpenKit whitelist.
 *
 * @param document Declarative A2UI document (data only).
 * @returns True when at least one unknown component type is present.
 */
export function documentHasUnknown(document: A2UIDocument): boolean {
  const stack = [document.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!isWhitelisted(node.type)) return true;
    if (node.children) {
      for (const child of node.children) stack.push(child);
    }
  }
  return false;
}

/**
 * Resolves the three-state presentation for a generative surface shell.
 *
 * @param input.streaming True while the agent is still composing the declaration.
 * @param input.document Parsed declarative document, or null while unavailable.
 * @returns `streaming` | `ready` | `fallback`.
 */
export function resolveRenderState(input: {
  streaming: boolean;
  document: A2UIDocument | null;
}): GenerativeRenderState {
  if (input.streaming || input.document === null) return 'streaming';
  if (documentHasUnknown(input.document)) return 'fallback';
  return 'ready';
}
