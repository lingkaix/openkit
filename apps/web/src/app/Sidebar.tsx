import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Icon, Menu, NavRow } from '../primitives';
import {
  chatThreadPath,
  useCurrentWorkspaceId,
  useThreads,
  useWorkspaces,
} from '../screens/chat/data';
import { AppSearch } from '../screens/operations';
import { useWorkspaceStore } from '../screens/workspace-store';
import { type NavGroup, type Surface, surfacesInGroup } from './surfaces';

/** Brand quad + wordmark (DESIGN.md §3.1). */
function BrandMark() {
  return (
    <div className="flex min-w-0 items-center gap-2 px-2 py-1">
      <span className="grid size-6 grid-cols-2 gap-0.5 overflow-hidden rounded-ok-sm" aria-hidden>
        <span className="bg-brand-1" />
        <span className="bg-brand-2" />
        <span className="bg-brand-3" />
        <span className="bg-brand-4" />
      </span>
      <span className="text-base font-extrabold text-fg-strong">OpenKit</span>
    </div>
  );
}

/** True when a surface's route is the one currently shown. */
function isActive(surface: Surface, pathname: string): boolean {
  if (surface.path === '/') return pathname === '/';
  if (surface.path === '/workspace') return pathname === '/workspace';
  if (surface.path.startsWith('/settings')) return pathname === surface.path;
  return pathname === surface.path || pathname.startsWith(`${surface.path}/`);
}

/** True when the current route is a Thread or other lineage-detail page. */
function isLineageDetailPath(pathname: string): boolean {
  return /^\/(chat|tasks|goals|materials)\//.test(pathname);
}

function NavSection({
  group,
  heading,
  pathname,
  go,
}: {
  group: NavGroup;
  heading?: string;
  pathname: string;
  go: (path: string) => void;
}) {
  const items = surfacesInGroup(group);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      {heading ? (
        <p className="px-3 pb-1 pt-3 text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted">
          {heading}
        </p>
      ) : null}
      {items.map((surface) => (
        <NavRow
          key={surface.id}
          icon={surface.icon}
          label={surface.title}
          active={isActive(surface, pathname)}
          onPress={() => go(surface.path)}
        />
      ))}
    </div>
  );
}

/** Brand-row Search command that opens the existing search overlay. */
function BrandSearch() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <div className="relative">
      <Button
        variant="quiet"
        aria-expanded={open}
        aria-label="Search"
        title="Search"
        className="h-8 w-8 px-0"
        onPress={() => setOpen((current) => !current)}
      >
        <Icon name="search" />
      </Button>
      {open ? (
        <section
          aria-label="Search"
          className="absolute right-0 top-full z-20 mt-1 w-60 rounded-ok-lg border border-border bg-elevated p-3 shadow-ok-menu"
        >
          <AppSearch onClose={() => setOpen(false)} />
        </section>
      ) : null}
    </div>
  );
}

/**
 * Left sidebar — navigation and persistent context (DESIGN.md §3.1).
 *
 * Two modes that never mix: App mode (brand and primary destinations) and Settings mode (Back to app and Settings categories).
 * The same quiet row grammar applies throughout.
 * Theme selection is NOT here — it lives in Settings → Appearance (§4.5).
 * Identity lives inside Settings, not a stacked user row (D-002).
 */
export function Sidebar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const workspaceId = useCurrentWorkspaceId();
  const setWorkspaceId = useWorkspaceStore((state) => state.setCurrentWorkspaceId);
  const workspace = workspaces.data?.find((candidate) => candidate.id === workspaceId) ?? null;
  const threads = useThreads(workspaceId);
  const go = (path: string) => navigate(path);
  const inSettings = pathname.startsWith('/settings');
  const compactSurfaces = surfacesInGroup('workspace-compact', workspace?.kind);
  const activeThreads = (threads.data ?? []).filter((thread) => thread.status === 'active');

  function switchWorkspace(nextWorkspaceId: string) {
    if (!nextWorkspaceId || nextWorkspaceId === workspaceId) return;
    setWorkspaceId(nextWorkspaceId);
    if (isLineageDetailPath(pathname)) {
      navigate('/chat');
    }
  }

  return (
    <nav
      aria-label={inSettings ? 'Settings sections' : 'Primary workspace navigation'}
      className="flex w-[264px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-separator bg-sunken p-3"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <BrandMark />
        <BrandSearch />
      </div>
      <div className="mb-2">
        <Menu
          fill
          label={workspace?.name ?? 'Select workspace'}
          selectedKey={workspaceId}
          items={(workspaces.data ?? []).map((item) => ({
            id: item.id,
            label: item.name,
          }))}
          onAction={(key) => switchWorkspace(String(key))}
        />
      </div>
      {inSettings ? (
        <>
          <NavRow icon="chevron-right" label="Back to app" onPress={() => go('/')} />
          <NavSection group="settings-user" heading="User" pathname={pathname} go={go} />
          <NavSection group="settings-server" heading="Server" pathname={pathname} go={go} />
          <NavSection group="settings-admin" heading="Administration" pathname={pathname} go={go} />
        </>
      ) : (
        <>
          <NavSection group="primary" pathname={pathname} go={go} />
          {workspace ? (
            <>
              <hr className="my-2 border-0 border-t border-separator" />
              <div className="flex flex-col gap-0.5">
                <p className="px-3 pb-1 pt-3 text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted">
                  Conversations
                </p>
                <NavRow icon="add" label="New conversation" onPress={() => go('/chat')} />
                {activeThreads.map((thread) => (
                  <NavRow
                    key={thread.id}
                    icon="chat"
                    label={thread.name ?? thread.preview}
                    active={['chat', 'tasks'].some((prefix) =>
                      pathname.startsWith(
                        `/${prefix}/${encodeURIComponent(workspace.id)}/${encodeURIComponent(thread.id)}`
                      )
                    )}
                    onPress={() => go(chatThreadPath(workspace.id, thread.id))}
                  />
                ))}
              </div>
            </>
          ) : null}
          <div className="mt-auto border-t border-separator pt-2">
            {workspace ? (
              <fieldset
                className="mb-2 flex items-center justify-between gap-0 border-0 p-0"
                aria-label="Workspace destinations"
              >
                {compactSurfaces.map((surface) => (
                  <Button
                    key={surface.id}
                    variant="quiet"
                    title={surface.title}
                    aria-label={surface.title}
                    aria-current={isActive(surface, pathname) ? 'page' : undefined}
                    className={[
                      'h-8 w-8 px-0',
                      isActive(surface, pathname) ? 'bg-selected text-accent-content' : '',
                    ].join(' ')}
                    onPress={() => go(surface.path)}
                  >
                    {surface.icon ? <Icon name={surface.icon} /> : null}
                  </Button>
                ))}
              </fieldset>
            ) : null}
            <NavRow icon="settings" label="Settings" onPress={() => go('/settings/account')} />
          </div>
        </>
      )}
    </nav>
  );
}
