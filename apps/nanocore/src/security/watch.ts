import type { SecurityFeedConfig } from '@openkit/config-schema';

/** Borrowed original step/check facts, not a new retained schedule or timestamp authority. */
export interface SecurityPeriodicCheck {
  readonly lastStartedAt: string | null;
  readonly inFlight: boolean;
}

/** Existing-owner feed observations, with completion evidence separate from nominal cadence. */
export interface SecurityFeedCheck extends SecurityPeriodicCheck {
  readonly id: string;
  readonly kind: SecurityFeedConfig['kind'];
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
}

/** Pure work eligibility and visible source assessments; none of these booleans grant an effect. */
export interface SecurityWatchAssessment {
  readonly dueInventory: boolean;
  readonly dueFeedIds: string[];
  readonly dueAudit: boolean;
  readonly dueNoticeDrain: boolean;
  readonly feedReports: {
    readonly id: string;
    readonly lastSuccessAt: string | null;
    readonly lastFailureAt: string | null;
    readonly stale: boolean;
    readonly failed: boolean;
  }[];
}

/**
 * Assesses the accepted cadence without scheduling, awaiting a feed, or changing its clock.
 * Original starts keep healthy polls within their nominal interval even after slow success.
 * Off or lost delegation ends detection eligibility, not outstanding-notice drain evaluation.
 * Actual admission, current grants, native writes and independent dispatch remain with callers.
 *
 * @param input Explicit caller event/time and transient projections of existing-owner facts.
 * @returns Due work and unchanged success/failure observations with derived staleness.
 */
export function assessSecurityWatch(input: {
  readonly now: string;
  readonly invocation: 'boot' | 'enable' | 'interval';
  readonly state: 'off' | 'on' | 'stopping';
  readonly delegationCurrent: boolean;
  readonly inventory: SecurityPeriodicCheck;
  readonly audit: SecurityPeriodicCheck;
  readonly feeds: readonly SecurityFeedCheck[];
  readonly notices: SecurityPeriodicCheck & { readonly outstanding: boolean };
}): SecurityWatchAssessment {
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new TypeError('Security assessment time is invalid.');
  const age = (timestamp: string): number => {
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed) || parsed > now)
      throw new TypeError('Security check evidence has an invalid or future timestamp.');
    return now - parsed;
  };
  const due = (check: SecurityPeriodicCheck, period: number): boolean =>
    !check.inFlight && (check.lastStartedAt === null || age(check.lastStartedAt) >= period);
  const detect = input.delegationCurrent && (input.state === 'on' || input.state === 'stopping');
  const feedReports = input.feeds.map((feed) => ({
    id: feed.id,
    lastSuccessAt: feed.lastSuccessAt,
    lastFailureAt: feed.lastFailureAt,
    stale: feed.lastSuccessAt === null || age(feed.lastSuccessAt) > feedInterval(feed.kind),
    failed:
      feed.lastFailureAt !== null &&
      (feed.lastSuccessAt === null || age(feed.lastFailureAt) < age(feed.lastSuccessAt)),
  }));
  return {
    dueInventory: detect && due(input.inventory, 86_400_000),
    dueFeedIds: detect
      ? input.feeds.filter((feed) => due(feed, feedInterval(feed.kind))).map((feed) => feed.id)
      : [],
    dueAudit: detect && due(input.audit, 300_000),
    dueNoticeDrain:
      input.notices.outstanding &&
      !input.notices.inFlight &&
      (input.invocation === 'boot' || due(input.notices, 300_000)),
    feedReports,
  };
}

/** E3 keeps hourly exploitation enrichment separate from daily OSV inventory checks. */
function feedInterval(kind: SecurityFeedConfig['kind']): number {
  switch (kind) {
    case 'kev':
    case 'rss':
      return 3_600_000;
    case 'osv-api':
    case 'osv-records':
      return 86_400_000;
    default:
      throw new TypeError('Unsupported security feed kind.');
  }
}
