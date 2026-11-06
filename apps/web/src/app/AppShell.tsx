import { useEffect, useRef, useState } from 'react';
import { Dialog, Modal, ModalOverlay } from 'react-aria-components';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Button, ToastProvider } from '../primitives';
import { AppUpdatePrompt } from '../pwa/AppUpdatePrompt';
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

/** Phone sections. Action Center is a count on Work's Tasks segment and a More row. */
function PhoneNav({ drawerOpen, onMore }: { drawerOpen: boolean; onMore: () => void }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const items: { label: string; path: string; active: boolean }[] = [
    {
      label: 'Assistant',
      path: '/',
      active: pathname === '/' || pathname.startsWith('/chat'),
    },
    {
      label: 'Work',
      path: '/work',
      active:
        pathname === '/work' || pathname.startsWith('/tasks') || pathname.startsWith('/goals'),
    },
    {
      label: 'Knowledge',
      path: '/knowledge',
      active: pathname === '/knowledge' || pathname.startsWith('/knowledge/'),
    },
    {
      label: 'Artifacts',
      path: '/artifacts',
      active: pathname === '/artifacts' || pathname.startsWith('/artifacts/'),
    },
  ];
  return (
    <nav aria-label="Sections" className="flex shrink-0 border-t border-separator bg-canvas">
      {items.map((item) => (
        <Button
          key={item.label}
          variant="quiet"
          className="min-h-11 min-w-11 flex-1 px-1"
          aria-current={item.active ? 'page' : undefined}
          onPress={() => navigate(item.path)}
        >
          {item.label}
        </Button>
      ))}
      <Button
        variant="quiet"
        className="min-h-11 min-w-11 flex-1 px-1"
        aria-expanded={drawerOpen}
        onPress={onMore}
      >
        More
      </Button>
    </nav>
  );
}

/**
 * App shell (DESIGN.md §3): two persistent regions plus one optional auxiliary.
 *
 * Left sidebar (264px) · centered main column (the routed surface). The optional
 * auxiliary rail is never a required region and never a decorative empty strip
 * (§3.3, Principle 8), so a surface that has an index renders its own rail (e.g.
 * the chat thread's artifacts rail) rather than the shell reserving dead space.
 * The document theme scopes the whole shell so every semantic utility retints
 * at once (§4.6). The shell has no minimum viewport: a phone uses the full
 * width, and wide content scrolls inside its own region. Safe-area insets pad
 * the shell. Below 800px the sidebar is gone. Five buttons sit on the bottom:
 * Assistant, Work, Knowledge, Artifacts, and More. More opens the supporting
 * drawer. The bar hides while a composer field is focused.
 * The global disconnected banner sits above the work area (§9.12). Search lives
 * on the sidebar brand row, not as a pinned main-view strip.
 */
export function AppShell() {
  const persistentNav = usePersistentNavigation();
  const { key: locationKey } = useLocation();
  const previousLocationKey = useRef(locationKey);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);

  useEffect(() => {
    if (persistentNav) setDrawerOpen(false);
  }, [persistentNav]);

  // Search hits and Workspace switches navigate outside the sidebar rows; location.key closes those destinations, including same-path pushes.
  useEffect(() => {
    if (previousLocationKey.current === locationKey) return;
    previousLocationKey.current = locationKey;
    setDrawerOpen(false);
  }, [locationKey]);

  useEffect(() => {
    const sync = () => setComposerFocused(document.activeElement instanceof HTMLTextAreaElement);
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', sync);
    return () => {
      document.removeEventListener('focusin', sync);
      document.removeEventListener('focusout', sync);
    };
  }, []);

  const sidebar = persistentNav ? (
    <Sidebar />
  ) : (
    <Sidebar variant="more" onClose={() => setDrawerOpen(false)} />
  );

  return (
    <div className="ok-safe-shell flex h-full min-h-0 min-w-0 bg-canvas text-fg">
      {persistentNav ? sidebar : null}
      {!persistentNav ? (
        <ModalOverlay
          isDismissable
          isOpen={drawerOpen}
          onOpenChange={setDrawerOpen}
          className="fixed inset-0 z-50 flex justify-start bg-fg/40"
        >
          <Modal className="h-full outline-none">
            <Dialog aria-label="More" className="flex h-full outline-none">
              {sidebar}
            </Dialog>
          </Modal>
        </ModalOverlay>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <AppUpdatePrompt />
        <DisconnectedBanner />
        <main aria-label="Workspace" className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
        {!persistentNav && !composerFocused ? (
          <PhoneNav drawerOpen={drawerOpen} onMore={() => setDrawerOpen(true)} />
        ) : null}
      </div>
      <ToastProvider />
    </div>
  );
}
