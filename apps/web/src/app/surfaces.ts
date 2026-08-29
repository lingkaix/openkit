import type { IconName } from '../primitives';

/**
 * Surface catalog — the single registry that drives the route tree, the sidebar
 * navigation, and feature-flag gating (DESIGN.md §3, §11). Each entry traces to a
 * Claude Design board frame. Tier is the §11 build tier:
 *   A — live (kernel-backed today)
 *   B — built, unpublished (contract not yet stable)
 *   C — deferred render-shell only
 */
export type Tier = 'A' | 'B' | 'C';

/** Where a surface appears in the sidebar; `route-only` surfaces are reached in-context. */
export type NavGroup =
  | 'primary'
  | 'workspace'
  | 'demos'
  | 'settings'
  | 'settings-demos'
  | 'route-only';

export interface Surface {
  /** Stable slug + React key. */
  id: string;
  /** Human title shown in nav and headers. */
  title: string;
  /** React Router path. */
  path: string;
  /** Build tier; only `A` may be published in navigation and routing. */
  tier: Tier;
  /** Sidebar placement. */
  nav: NavGroup;
  /** Leading nav glyph. */
  icon?: IconName;
  /** Claude Design board frame(s) this surface projects (traceability). */
  board: string;
  /** Work package that builds the real screen. */
  wp: string;
}

export const SURFACES: Surface[] = [
  // Tier A — primary destinations
  {
    id: 'overview',
    title: 'Overview',
    path: '/',
    tier: 'A',
    nav: 'primary',
    icon: 'home',
    board: '07',
    wp: 'WP-6',
  },
  {
    id: 'chat',
    title: 'Chat',
    path: '/chat',
    tier: 'A',
    nav: 'primary',
    icon: 'chat',
    board: '01',
    wp: 'WP-4',
  },
  {
    id: 'knowledge',
    title: 'Knowledge',
    path: '/knowledge',
    tier: 'A',
    nav: 'primary',
    icon: 'book',
    board: '14',
    wp: 'WP-6',
  },
  {
    id: 'agents',
    title: 'Agents',
    path: '/agents',
    tier: 'A',
    nav: 'primary',
    icon: 'agents',
    board: '08',
    wp: 'WP-6',
  },
  {
    id: 'repositories',
    title: 'Repositories',
    path: '/repositories',
    tier: 'A',
    nav: 'workspace',
    icon: 'repository',
    board: '19',
    wp: 'WP-7',
  },
  // Tier A — reached in-context (route-only)
  {
    id: 'chat-thread',
    title: 'Chat',
    path: '/chat/:threadId',
    tier: 'A',
    nav: 'route-only',
    board: '02/03',
    wp: 'WP-4',
  },
  {
    id: 'task-thread',
    title: 'Task',
    path: '/tasks/:threadId',
    tier: 'A',
    nav: 'route-only',
    board: '04',
    wp: 'WP-4',
  },
  {
    id: 'goal',
    title: 'Goal',
    path: '/goals/:threadId',
    tier: 'A',
    nav: 'route-only',
    board: '05/05b/05c/06/21',
    wp: 'WP-5',
  },
  {
    id: 'artifact-review',
    title: 'Artifact review',
    path: '/goals/:threadId/artifacts/:artifactId',
    tier: 'A',
    nav: 'route-only',
    board: '12',
    wp: 'WP-5',
  },
  {
    id: 'material',
    title: 'Material',
    path: '/materials/:threadId/:materialId?',
    tier: 'A',
    nav: 'route-only',
    board: '05c/12/11/22',
    wp: 'WP-5',
  },
  {
    id: 'first-run',
    title: 'Welcome',
    path: '/first-run',
    tier: 'A',
    nav: 'route-only',
    board: '18',
    wp: 'WP-6',
  },
  {
    id: 'new-workspace',
    title: 'New workspace',
    path: '/workspaces/new',
    tier: 'A',
    nav: 'route-only',
    board: '07',
    wp: 'WP-6',
  },

  // Tier B — built, unpublished
  {
    id: 'automations',
    title: 'Automations',
    path: '/automations',
    tier: 'B',
    nav: 'demos',
    icon: 'automations',
    board: '09',
    wp: 'WP-8',
  },
  // Tier C — deferred render-shell only
  {
    id: 'generative',
    title: 'Generative UI',
    path: '/generative',
    tier: 'C',
    nav: 'demos',
    icon: 'generative',
    board: '13',
    wp: 'WP-9',
  },

  // Settings (Tier A core)
  {
    id: 'account',
    title: 'Account',
    path: '/settings/account',
    tier: 'A',
    nav: 'settings',
    icon: 'settings',
    board: '18/10/11/22',
    wp: 'WP-8',
  },
  {
    id: 'settings',
    title: 'General',
    path: '/settings',
    tier: 'A',
    nav: 'settings',
    icon: 'settings',
    board: '10',
    wp: 'WP-7',
  },
  {
    id: 'appearance',
    title: 'Appearance',
    path: '/settings/appearance',
    tier: 'A',
    nav: 'settings',
    icon: 'view',
    board: '22',
    wp: 'WP-3',
  },
  {
    id: 'ai-interface',
    title: 'AI interface',
    path: '/settings/ai-interface',
    tier: 'A',
    nav: 'settings',
    icon: 'connect',
    board: '20',
    wp: 'WP-7',
  },
  {
    id: 'vault',
    title: 'Vault',
    path: '/settings/vault',
    tier: 'A',
    nav: 'settings',
    icon: 'key',
    board: '15',
    wp: 'WP-7',
  },
  {
    id: 'usage',
    title: 'Usage & audit',
    path: '/settings/usage',
    tier: 'A',
    nav: 'settings',
    icon: 'usage',
    board: '17',
    wp: 'WP-7',
  },
  {
    id: 'debug',
    title: 'Debug',
    path: '/settings/debug',
    tier: 'A',
    nav: 'settings',
    icon: 'file',
    board: '11',
    wp: 'WP-2',
  },

  // Settings (Tier B, unpublished)
  {
    id: 'channels',
    title: 'Channels',
    path: '/settings/channels',
    tier: 'B',
    nav: 'settings-demos',
    icon: 'chat',
    board: '16',
    wp: 'WP-8',
  },
];

/** Look up a surface by id. */
export function surfaceById(id: string): Surface | undefined {
  return SURFACES.find((s) => s.id === id);
}

/** Surfaces in a given sidebar group, in declaration order. */
export function surfacesInGroup(group: NavGroup): Surface[] {
  return SURFACES.filter((s) => s.nav === group);
}
