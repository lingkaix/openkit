/** Portable test-only wall-clock schedules and identity accounting for the r2 envelope. */
/** Named repetitions share the frozen schedule; instrumentation does not change offers. */
export const LOAD_PROFILES = {
  'rep1-1ws': { profile: 'reference', workspaces: 1 },
  'rep1-4ws': { profile: 'reference', workspaces: 4 },
  'rep2-1ws': { profile: 'reference', workspaces: 1 },
  'rep2-4ws': { profile: 'reference', workspaces: 4 },
  'rep1-one': { profile: 'one', workspaces: 1 },
  'rep2-one': { profile: 'one', workspaces: 1 },
  ISO: { profile: 'iso', workspaces: 4 },
  'ISO-10T': { profile: 'ISO-10T', workspaces: 4 },
} as const;
export type CloseProfile = 'reference' | 'iso' | 'ISO-10T' | 'one';
/** Standard ISO is 72 native plus 8 effect Turns on hot, 9 plus 1 on siblings. */
export function topology(
  profile: CloseProfile,
  workspaces: number,
  workspace: number,
  smokeHotRate = 400
) {
  const actors =
    profile === 'one' ? 1 : profile === 'iso' && workspace === 0 ? 80 : 40 / workspaces;
  const effects = profile === 'one' ? 0 : actors / 10;
  return {
    actors,
    effects,
    native: actors - effects,
    offered:
      profile === 'one'
        ? 20
        : profile === 'iso' || profile === 'ISO-10T'
          ? workspace === 0
            ? smokeHotRate
            : 5
          : undefined,
  };
}
/** Protocol errors without an explicit commit field are never inferred to be refusals. */
export function classifyOutcomeError(error: any): {
  status: 'refused' | 'unknown';
  code?: string;
  commit?: string;
} {
  const protocol = error?.name === 'ProtocolError';
  const commit = protocol
    ? typeof error?.data?.commit === 'string'
      ? error.data.commit
      : undefined
    : typeof error?.commit === 'string'
      ? error.commit
      : undefined;
  const code =
    typeof error?.code === 'string'
      ? error.code
      : protocol && typeof error?.data?.code === 'string'
        ? error.data.code
        : undefined;
  return { status: commit === 'not-committed' ? 'refused' : 'unknown', code, commit };
}
export type Slot = {
  id: string;
  workspace: number;
  actor: number;
  effect: boolean;
  ordinal: number;
  dueMs: number;
  steady: boolean;
};
export type Outcome = Slot & {
  issuedMs?: number;
  ackMs?: number;
  status: 'scheduled' | 'acked' | 'refused' | 'unknown';
  code?: string;
  commit?: string;
};
export function isoTenTurnCriteria(
  rows: Array<Outcome & { error?: { name?: string; dataCode?: string } }>,
  settled: boolean,
  warmMs: number,
  windowMs: number
) {
  const hot = rows.filter((r) => r.steady && r.workspace === 0),
    refusals = hot.filter((r) => r.status === 'refused');
  const served = (r: Outcome) =>
    r.status === 'acked' &&
    r.ackMs !== undefined &&
    r.ackMs >= warmMs &&
    r.ackMs < warmMs + windowMs;
  return {
    diagnosticOnly: true,
    boundedDrainWithin30s: settled,
    otherHotTurnsKeepService: Array.from({ length: 8 }, (_, i) => i + 1).every((actor) =>
      hot.some((r) => r.actor === actor && served(r))
    ),
    effectsKeepService: hot.some((r) => r.effect && served(r)),
    explicitScopeLocalRefusal:
      refusals.length > 0 &&
      refusals.every(
        (r) =>
          r.commit === 'not-committed' &&
          (r.code === 'busy' ||
            (r.error?.name === 'ProtocolError' &&
              r.error?.dataCode === 'operation_storage_unavailable'))
      ) &&
      rows.filter((r) => r.steady && r.workspace > 0).every((r) => r.status !== 'refused'),
  };
}
export function schedule(
  profile: CloseProfile,
  workspaces: number,
  rate = 202,
  warmMs = 20000,
  windowMs = 300000,
  smokeHotRate = 400
): Slot[] {
  if (!Number.isFinite(smokeHotRate) || smokeHotRate <= 0) throw Error('Invalid hot offer rate');
  if (
    !['reference', 'iso', 'ISO-10T', 'one'].includes(profile) ||
    ![1, 4].includes(workspaces) ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    warmMs < 0 ||
    windowMs <= 0
  )
    throw Error('Invalid test profile');
  if (
    ((profile === 'iso' || profile === 'ISO-10T') && workspaces !== 4) ||
    (profile === 'one' && workspaces !== 1)
  )
    throw Error('Invalid profile distribution');
  const slots: Slot[] = [];
  for (let w = 0; w < workspaces; w++) {
    const shape = topology(profile, workspaces, w, smokeHotRate),
      actors = shape.actors;
    const offered = shape.offered ?? rate / workspaces;
    for (let tick = 0; ; tick++) {
      const dueMs = (tick * 1000 * actors) / offered;
      if (dueMs >= warmMs + windowMs - 1e-7) break;
      for (let actor = 0; actor < actors; actor++)
        slots.push({
          id: `${w}:${tick}:${actor}`,
          workspace: w,
          actor,
          effect: profile !== 'one' && actor >= actors * 0.9,
          ordinal: tick,
          dueMs,
          steady: dueMs >= warmMs - 1e-7,
        });
    }
  }
  return slots.sort(
    (a, b) =>
      a.dueMs - b.dueMs ||
      Number(a.effect) - Number(b.effect) ||
      a.workspace - b.workspace ||
      a.actor - b.actor
  );
}
export function account(rows: Outcome[], warmMs: number, windowMs: number, workspaces: number) {
  const stop = warmMs + windowMs;
  const summarize = (all: Outcome[]) => {
    const steady = all.filter((x) => x.steady),
      issued = steady.filter((x) => x.issuedMs !== undefined),
      acknowledged = steady.filter((x) => x.status === 'acked');
    return {
      scheduled: steady.length,
      scheduledEffects: steady.filter((x) => x.effect).length,
      issued: issued.length,
      missed: steady.length - issued.length,
      ackedInWindow: all.filter(
        (x) => x.status === 'acked' && x.ackMs! >= warmMs && x.ackMs! < stop
      ).length,
      effectsAckedInWindow: all.filter(
        (x) => x.effect && x.status === 'acked' && x.ackMs! >= warmMs && x.ackMs! < stop
      ).length,
      scheduledAckedInWindow: acknowledged.filter((x) => x.ackMs! >= warmMs && x.ackMs! < stop)
        .length,
      scheduledEffectsAckedInWindow: acknowledged.filter(
        (x) => x.effect && x.ackMs! >= warmMs && x.ackMs! < stop
      ).length,
      busyRefused: steady.filter((x) => x.status === 'refused' && x.code === 'busy').length,
      otherRefused: steady.filter((x) => x.status === 'refused' && x.code !== 'busy').length,
      eventuallyAcked: acknowledged.length,
      refused: steady.filter((x) => x.status === 'refused').length,
      unknown: steady.filter((x) => x.status === 'unknown').length,
      late: acknowledged.filter((x) => x.ackMs! >= stop).length,
      unresolved: steady.filter((x) => x.issuedMs !== undefined && x.status === 'scheduled').length,
      allPhaseUnknown: all.filter((x) => x.status === 'unknown').length,
      allPhaseRefused: all.filter((x) => x.status === 'refused').length,
      allPhaseUnresolved: all.filter((x) => x.issuedMs !== undefined && x.status === 'scheduled')
        .length,
    };
  };
  if (new Set(rows.map((x) => x.id)).size !== rows.length)
    throw Error('Duplicate scheduled identity');
  const total = summarize(rows),
    siblings = Array.from({ length: workspaces }, (_, w) => ({
      workspace: w,
      ...summarize(rows.filter((x) => x.workspace === w)),
    }));
  if (
    total.scheduled !==
    total.missed + total.eventuallyAcked + total.refused + total.unknown + total.unresolved
  )
    throw Error('Identity disposition did not reconcile');
  return { total, siblings };
}
