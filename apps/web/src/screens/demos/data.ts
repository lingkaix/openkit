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
export const TIER_B_SURFACE_IDS = ['automations', 'channels'] as const;

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

/** Channel connection row for board 16. */
export interface ChannelRow {
  id: string;
  name: string;
  meta: string;
  connected: boolean;
  enabled: boolean;
}

/** Outbound travel preference for channels. */
export interface ChannelTravelSetting {
  id: string;
  title: string;
  help: string;
  enabled: boolean;
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

const SAMPLE_CHANNELS: ChannelRow[] = [
  {
    id: 'chan_slack',
    name: 'Slack',
    meta: '#openkit-alerts in Acme HQ',
    connected: true,
    enabled: true,
  },
  {
    id: 'chan_email',
    name: 'Email digest',
    meta: 'Daily at 8:00 · sw@acme.com',
    connected: true,
    enabled: true,
  },
  {
    id: 'chan_discord',
    name: 'Discord',
    meta: 'Not connected',
    connected: false,
    enabled: false,
  },
  {
    id: 'chan_signal',
    name: 'Signal',
    meta: 'Not connected',
    connected: false,
    enabled: false,
  },
];

const SAMPLE_TRAVEL: ChannelTravelSetting[] = [
  {
    id: 'travel_approvals',
    title: 'Approvals and blocked work',
    help: 'Decide with one tap from the channel — no need to open OpenKit.',
    enabled: true,
  },
  {
    id: 'travel_finished',
    title: 'Finished goals and reviews',
    help: 'A short result note with a link back to the artifacts.',
    enabled: true,
  },
  {
    id: 'travel_progress',
    title: 'Progress chatter',
    help: 'Step-by-step updates stay in the thread.',
    enabled: false,
  },
];

/**
 * Automations list for board 09.
 *
 * @returns Sample automations while the surface is not live.
 */
export function useAutomations(): DemoQueryResult<AutomationRow[]> {
  const isDemo = useDemoFixtures('automations');
  // Live path (future): core-client listAutomations → same AutomationRow[].
  return { data: SAMPLE_AUTOMATIONS, isDemo };
}

/**
 * Channels settings for board 16.
 *
 * @returns Sample channel + travel preferences while not live.
 */
export function useChannels(): DemoQueryResult<{
  channels: ChannelRow[];
  travel: ChannelTravelSetting[];
}> {
  const isDemo = useDemoFixtures('channels');
  return { data: { channels: SAMPLE_CHANNELS, travel: SAMPLE_TRAVEL }, isDemo };
}
