import type { ThreadRouteState } from '../screens/chat/data';

/** Where an address from before the one Thread route (WEB-UX B1) now lives. */
export interface LegacyTarget {
  /** Path, search and hash of the current address. */
  readonly to: string;
  /** The activity the old typed route named, kept as the Thread route hint. */
  readonly state?: ThreadRouteState;
}

const TYPED: Record<string, ThreadRouteState['threadActivity']> = {
  chat: 'chat',
  tasks: 'task',
  goals: 'goal',
};

/**
 * Maps a retired address to its current one, or null when it is not retired.
 *
 * `/chat/:w/:t`, `/tasks/:w/:t`, `/goals/:w/:t` (and `/goals/:w/:t/artifacts/:a`) become
 * `/w/:w/t/:t…`; `/chat` becomes `/assistant`; `/attention` becomes `/needs-you`. Like the old
 * React Router patterns, the fixed words match in any letter case and trailing slashes are
 * ignored. The encoded path segments are copied as they are, so an identity is never decoded
 * and re-encoded. Search and hash are kept (anchors such as `?turnId=` and `?card=` keep working).
 */
export function legacyTarget(pathname: string, search = '', hash = ''): LegacyTarget | null {
  const tail = `${search}${hash}`;
  const path = pathname.replace(/\/+$/, '');
  const fixed = path.toLowerCase();
  if (fixed === '/chat') return { to: `/assistant${tail}` };
  if (fixed === '/attention') return { to: `/needs-you${tail}` };
  const match = /^\/(chat|tasks|goals)\/([^/]+)\/([^/]+)(?:\/(artifacts)\/([^/]+))?$/i.exec(path);
  if (!match) return null;
  const [, kind = '', workspaceId, threadId, artifacts, artifactId] = match;
  const activity = TYPED[kind.toLowerCase()];
  if (!activity) return null;
  if (artifacts && activity !== 'goal') return null;
  const rest = artifacts ? `/artifacts/${artifactId}` : '';
  return {
    to: `/w/${workspaceId}/t/${threadId}${rest}${tail}`,
    state: { threadActivity: activity },
  };
}
