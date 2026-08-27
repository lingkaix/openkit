import type { Surface } from './surfaces';

/**
 * Feature-flag gating (DESIGN.md §11, Principle 8).
 *
 * The full board set is built, but a surface whose kernel/protocol contract is
 * not yet stable (Tier B/C) ships disabled — reachable only as a labeled, inert
 * concept demo (see `ConceptDemo`), never wired as if it were live. Tier A is
 * always live. This is the single owner of the "is this surface operational?"
 * decision; the route tree consults it to decide whether to wrap a surface.
 */
export function isSurfaceLive(surface: Surface): boolean {
  return surface.tier === 'A';
}
