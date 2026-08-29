import { useLocation, useNavigate } from 'react-router-dom';
import { NavRow } from '../primitives';
import { useCurrentWorkspaceId, useWorkspaces } from '../screens/chat/data';
import { type NavGroup, type Surface, surfaceById, surfacesInGroup } from './surfaces';

/** Brand quad + wordmark (DESIGN.md §3.1). */
function BrandMark() {
  return (
    <div className="mb-2 flex items-center gap-2 px-2 py-1">
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
  // Settings sub-pages match exactly; app destinations match by prefix (thread ids etc.).
  if (surface.path.startsWith('/settings')) return pathname === surface.path;
  return pathname === surface.path || pathname.startsWith(`${surface.path}/`);
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
      {group === 'workspace' ? (
        <NavRow icon="settings" label="Workspace settings" onPress={() => go('/settings')} />
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
  const workspace = workspaces.data?.find((candidate) => candidate.id === workspaceId) ?? null;
  const go = (path: string) => navigate(path);
  const inSettings = pathname.startsWith('/settings');

  return (
    <nav
      aria-label={inSettings ? 'Settings sections' : 'Primary workspace navigation'}
      className="flex w-[264px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-separator bg-sunken p-3"
    >
      {inSettings ? (
        <>
          <NavRow icon="chevron-right" label="Back to app" onPress={() => go('/')} />
          <NavSection group="settings" heading="Settings" pathname={pathname} go={go} />
        </>
      ) : (
        <>
          <BrandMark />
          <NavSection group="primary" pathname={pathname} go={go} />
          <NavRow
            icon="add"
            label="New workspace"
            active={isActive(surfaceById('new-workspace') as Surface, pathname)}
            onPress={() => go('/workspaces/new')}
          />
          {workspace ? (
            <NavSection group="workspace" heading={workspace.name} pathname={pathname} go={go} />
          ) : null}
          <div className="mt-auto border-t border-separator pt-2">
            <NavRow icon="settings" label="Settings" onPress={() => go('/settings')} />
          </div>
        </>
      )}
    </nav>
  );
}
