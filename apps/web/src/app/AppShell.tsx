import { useEffect, useRef, useState } from 'react';
import { Dialog, Modal, ModalOverlay } from 'react-aria-components';
import { Outlet, useLocation } from 'react-router-dom';
import { Button, ToastProvider } from '../primitives';
import { DisconnectedBanner } from './DisconnectedBanner';
import { Sidebar } from './Sidebar';

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
function usePersistentNavigation(): boolean {
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

/**
 * App shell (DESIGN.md §3): two persistent regions plus one optional auxiliary.
 *
 * Left sidebar (264px) · centered main column (the routed surface). The optional
 * auxiliary rail is never a required region and never a decorative empty strip
 * (§3.3, Principle 8), so a surface that has an index renders its own rail (e.g.
 * the chat thread's artifacts rail) rather than the shell reserving dead space.
 * The document theme scopes the whole shell so every semantic utility retints
 * at once (§4.6). The shell holds its structure down to the 600×600 workbench
 * floor (§3.4, §12) with no horizontal body overflow — wide content scrolls
 * inside its own region. Below 800px the left navigation starts closed and opens
 * as a React Aria modal overlay drawer from a labelled Navigation control.
 * The global disconnected banner sits above the work area (§9.12). Search lives
 * on the sidebar brand row, not as a pinned main-view strip.
 */
export function AppShell() {
  const persistentNav = usePersistentNavigation();
  const { key: locationKey } = useLocation();
  const previousLocationKey = useRef(locationKey);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (persistentNav) setDrawerOpen(false);
  }, [persistentNav]);

  // Search hits and Workspace switches navigate outside the sidebar rows; location.key closes those destinations, including same-path pushes.
  useEffect(() => {
    if (previousLocationKey.current === locationKey) return;
    previousLocationKey.current = locationKey;
    setDrawerOpen(false);
  }, [locationKey]);

  const sidebar = persistentNav ? <Sidebar /> : <Sidebar onClose={() => setDrawerOpen(false)} />;

  return (
    <div className="flex h-full min-h-[600px] min-w-[600px] bg-canvas text-fg">
      {persistentNav ? sidebar : null}
      {!persistentNav ? (
        <ModalOverlay
          isDismissable
          isOpen={drawerOpen}
          onOpenChange={setDrawerOpen}
          className="fixed inset-0 z-50 flex justify-start bg-fg/40"
        >
          <Modal className="h-full outline-none">
            <Dialog aria-label="Navigation" className="flex h-full outline-none">
              {sidebar}
            </Dialog>
          </Modal>
        </ModalOverlay>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        {!persistentNav ? (
          <div className="flex shrink-0 items-center border-b border-separator px-3 py-2">
            <Button variant="quiet" aria-expanded={drawerOpen} onPress={() => setDrawerOpen(true)}>
              Navigation
            </Button>
          </div>
        ) : null}
        <DisconnectedBanner />
        <main aria-label="Workspace" className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <ToastProvider />
    </div>
  );
}
