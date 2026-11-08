import type { LensName } from './types';

/** Device-local lens. One browser profile, every conversation. */
export const TIMELINE_LENS_KEY = 'openkit.timeline.lens';

/** Work unless this device previously chose Full. */
export function readStoredLens(): LensName {
  try {
    return localStorage.getItem(TIMELINE_LENS_KEY) === 'full' ? 'full' : 'work';
  } catch {
    return 'work';
  }
}

/** Remember the lens on this device. */
export function writeStoredLens(lens: LensName): void {
  try {
    localStorage.setItem(TIMELINE_LENS_KEY, lens);
  } catch {
    // A private browser may reject storage. The in-memory lens still applies.
  }
}
