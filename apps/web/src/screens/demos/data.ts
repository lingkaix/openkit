import { isSurfaceLive } from '../../app/flags';
import { surfaceById } from '../../app/surfaces';
import type { StatusTone } from '../../primitives';

/**
 * Tier-B review-data seam (WP-8).
 *
 * Screens read through these hooks. While a surface is not live (`isSurfaceLive`
 * false), hooks return sample / last-known fixtures so §9.13 states render without
 * calling unstable live mutation APIs. When a contract stabilizes and the flag
 * flips on, replace the fixture branch with core-client reads of the same shape —
 * markup stays unchanged.
 */

/** Stable WP-8 Tier-B surface ids. */
export const TIER_B_SURFACE_IDS = ['automations'] as const;

export type TierBSurfaceId = (typeof TIER_B_SURFACE_IDS)[number];

/** Result shape shared by demo-data hooks. */
export interface DemoQueryResult<T> {
  /** Projected rows or payload for the screen. */
  data: T;
  /** True while the surface remains unpublished. */
  isDemo: boolean;
}

/**
 * Returns whether a Tier-B surface should still use fixture data.
 *
 * @param id Surface catalog id.
 * @returns True when the surface is not live.
 */
export function useDemoFixtures(id: TierBSurfaceId): boolean {
  const surface = surfaceById(id);
  return !surface || !isSurfaceLive(surface);
}

/** One automation row for board 09. */
export interface AutomationRow {
  id: string;
  name: string;
  description: string;
  schedule: string;
  workspace: string;
  statusLabel: string;
  statusTone: StatusTone;
}

const SAMPLE_AUTOMATIONS: AutomationRow[] = [
  {
    id: 'auto_1',
    name: 'Monday interview digest',
    description: 'Summarizes new customer interviews into one note.',
    schedule: 'Every Monday 8:00',
    workspace: 'Market research',
    statusLabel: 'Done Mon',
    statusTone: 'positive',
  },
  {
    id: 'auto_2',
    name: 'Competitor news watch',
    description: 'Flags new competitor announcements each morning.',
    schedule: 'Every weekday 7:30',
    workspace: 'Market research',
    statusLabel: 'Running now',
    statusTone: 'informative',
  },
  {
    id: 'auto_3',
    name: 'Monthly expense summary',
    description: 'Rolls up spending by category for your review.',
    schedule: 'First of the month 9:00',
    workspace: 'Ops & finance',
    statusLabel: 'Paused',
    statusTone: 'neutral',
  },
];

/**
 * Automations list for board 09.
 *
 * @returns Sample automations while the surface is not live.
 */
export function useAutomations(): DemoQueryResult<AutomationRow[]> {
  const isDemo = useDemoFixtures('automations');
  // Live path (future): client.operations['automation.list'] → same AutomationRow[].
  return { data: SAMPLE_AUTOMATIONS, isDemo };
}
