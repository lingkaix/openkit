import type { Surface } from './surfaces';

/**
 * Surface publication gating (DESIGN.md §11, Principle 8).
 *
 * A surface whose kernel/protocol contract is not yet stable (Tier B/C) remains unpublished instead of appearing as inactive product UI.
 * The route tree uses this predicate, while the sidebar omits the internal review groups entirely.
 * Tier A is always live.
 */
export function isSurfaceLive(surface: Surface): boolean {
  return surface.tier === 'A';
}
