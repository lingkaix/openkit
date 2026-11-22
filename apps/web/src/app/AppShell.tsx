import { useEffect, useRef, useState } from 'react';
import { Dialog, Modal, ModalOverlay } from 'react-aria-components';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ActionButton, ToastProvider } from '../primitives';
import { AppUpdatePrompt } from '../pwa/AppUpdatePrompt';
import { TimelineToasts } from '../screens/chat/timeline/TimelineToasts';
import { DisconnectedBanner } from './DisconnectedBanner';
import { usePersistentNavigation } from './persistent-nav';
import { Sidebar } from './Sidebar';
import { SearchPaletteProvider } from './search/SearchPalette';
import { useThreadActivityAt } from './thread-activity';

export { usePersistentNavigation } from './persistent-nav';

/** Phone sections. Needs you is a count on Work's Tasks segment and a More row. */
function PhoneNav({ drawerOpen, onMore }: { drawerOpen: boolean; onMore: () => void }) {
  const { pathname, state } = useLocation();
  const navigate = useNavigate();
  const thread = useThreadActivityAt(pathname, state);
  const items: { label: string; path: string; active: boolean }[] = [
    {
      label: 'Assistant',
      path: '/assistant',
      active:
        pathname === '/' || pathname === '/assistant' || pathname === '/new' || thread === 'chat',
    },
    {
      label: 'Work',
      path: '/work',
      active: pathname === '/work' || thread === 'task' || thread === 'goal',
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
        <ActionButton
          key={item.label}
          isQuiet
          className="min-h-12 min-w-0 flex-1 whitespace-nowrap px-0.5 text-center text-xs"
          aria-current={item.active ? 'page' : undefined}
          onPress={() => navigate(item.path)}
        >
          {item.label}
        </ActionButton>
      ))}
      <ActionButton
        isQuiet
        className="min-h-12 min-w-0 flex-1 whitespace-nowrap px-0.5 text-center text-xs"
        aria-expanded={drawerOpen}
        onPress={onMore}
      >
        More
      </ActionButton>
    </nav>
  );
}

/**
 * App shell (DESIGN.md §3): two persistent regions plus one optional auxiliary.
 *
 * Left sidebar (240px) · centered main column (the routed surface). The optional
 * auxiliary rail is never a required region and never a decorative empty strip
 * (§3.3, Principle 8), so a surface that has an index renders its own rail (e.g.
 * the chat thread's artifacts rail) rather than the shell reserving dead space.
 * The document theme scopes the whole shell so every semantic utility retints
 * at once (§4.6). The shell has no minimum viewport: a phone uses the full
 * width, and wide content scrolls inside its own region. Safe-area insets pad
 * the shell. Below 800px the sidebar is gone. Five buttons sit on the bottom:
 * Assistant, Work, Knowledge, Artifacts, and More. Each label stays on one line
 * so a 390px bar cannot break a word. More opens the drawer, which holds the same
 * content as the desktop sidebar (ia.md §1). The bar
 * hides while a composer field is focused.
 * The global disconnected banner sits above the work area (§9.12). Search is the
 * sidebar Search row and ⌃K / ⌘K anywhere (ia.md §1a), never a pinned main-view strip.
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

  const sidebar = persistentNav ? <Sidebar /> : <Sidebar onClose={() => setDrawerOpen(false)} />;

  return (
    <SearchPaletteProvider>
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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
        <TimelineToasts />
      </div>
    </SearchPaletteProvider>
  );
}
