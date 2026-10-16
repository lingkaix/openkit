// Synthetic, read-only domain calculation. This creates no booking and grants no authority.
let body = '';
for await (const chunk of process.stdin) {
  body += chunk;
  if (Buffer.byteLength(body) > 64 * 1024) {
    process.stdout.write(
      JSON.stringify({ outcome: 'blocked', reason: 'invalid-input', evidence: [] })
    );
    process.exit(0);
  }
}
const blocked = (reason, evidence = []) => ({ outcome: 'blocked', reason, evidence });
const time = (value) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    ? Date.parse(value)
    : NaN;
const count = (value) => Number.isInteger(value) && value >= 0 && value <= 1000;
function propose(input) {
  if (
    !input ||
    !Array.isArray(input.sources) ||
    input.sources.length > 16 ||
    !count(input.quantity) ||
    input.quantity === 0 ||
    typeof input.equipmentId !== 'string'
  )
    return blocked('invalid-input');
  const start = time(input.start),
    end = time(input.end),
    asOf = time(input.asOf);
  if (![start, end, asOf].every(Number.isFinite) || start >= end) return blocked('invalid-input');
  const evidence = [];
  let capacity;
  const reservations = new Map();
  for (const source of input.sources) {
    if (
      source?.synthetic !== true ||
      source.audience !== 'workspace' ||
      typeof source.id !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(source.contentDigest ?? '') ||
      !Array.isArray(source.facts)
    )
      return blocked('invalid-evidence');
    evidence.push({ id: source.id, contentDigest: source.contentDigest });
    if (
      !Number.isFinite(time(source.observedAt)) ||
      !Number.isFinite(time(source.validUntil)) ||
      asOf < time(source.observedAt) ||
      asOf > time(source.validUntil)
    )
      return blocked('stale-evidence', evidence);
    for (const fact of source.facts) {
      if (fact.equipmentId !== input.equipmentId) continue;
      if (fact.kind === 'inventory' && count(fact.capacity)) {
        if (capacity !== undefined && capacity !== fact.capacity)
          return blocked('conflicting-evidence', evidence);
        capacity = fact.capacity;
      } else if (
        fact.kind === 'reservation' &&
        typeof fact.id === 'string' &&
        count(fact.quantity) &&
        Number.isFinite(time(fact.start)) &&
        Number.isFinite(time(fact.end)) &&
        time(fact.start) < time(fact.end)
      ) {
        const previous = reservations.get(fact.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(fact))
          return blocked('conflicting-evidence', evidence);
        reservations.set(fact.id, fact);
      } else return blocked('invalid-evidence', evidence);
    }
  }
  if (capacity === undefined || !input.sources.some((source) => source.purpose === 'reservations'))
    return blocked('missing-evidence', evidence);
  const events = [...reservations.values()]
    .filter((reservation) => time(reservation.start) < end && start < time(reservation.end))
    .flatMap((reservation) => [
      [Math.max(start, time(reservation.start)), reservation.quantity],
      [Math.min(end, time(reservation.end)), -reservation.quantity],
    ])
    .sort(
      ([leftTime, leftCount], [rightTime, rightCount]) =>
        leftTime - rightTime || leftCount - rightCount
    );
  // Capacity applies to concurrent use; an ending half-open interval releases units before the next start.
  let concurrent = 0;
  let used = 0;
  for (const [, change] of events) {
    concurrent += change;
    used = Math.max(used, concurrent);
  }
  return {
    outcome: used + input.quantity <= capacity ? 'propose' : 'decline',
    reason: used + input.quantity <= capacity ? 'snapshot-capacity' : 'capacity-exceeded',
    evidence,
  };
}
let result;
try {
  result = propose(JSON.parse(body));
} catch {
  result = blocked('invalid-input');
}
process.stdout.write(JSON.stringify(result));
