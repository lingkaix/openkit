import { useEffect, useState } from 'react';

/** Viewport width at which the left navigation stays a persistent sidebar. */
const PERSISTENT_NAV_QUERY = '(min-width: 800px)';

/**
 * True when the current viewport is at least 800px wide.
 *
 * @returns Whether the left navigation should stay persistent.
 */
function readPersistentNavigation(): boolean {
  return window.matchMedia?.(PERSISTENT_NAV_QUERY)?.matches ?? true;
}

/**
 * Tracks the 800px persistent-navigation breakpoint.
 *
 * @returns Whether the left navigation should stay in the layout.
 */
export function usePersistentNavigation(): boolean {
  const [persistent, setPersistent] = useState(readPersistentNavigation);
  useEffect(() => {
    const media = window.matchMedia?.(PERSISTENT_NAV_QUERY);
    if (!media) return undefined;
    const sync = () => setPersistent(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return persistent;
}
