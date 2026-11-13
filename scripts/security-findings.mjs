/** Read-only Development Security release predicates; no private register is retained or logged. */
const classes = new Set(['K', 'C', 'H', 'N']);
const statuses = new Set(['open', 'mitigated', 'fixed', 'not_affected', 'accepted']);
const roles = new Set(['engineer', 'maintainer', 'agent']);
const justifications = new Set([
  'component_not_present',
  'vulnerable_code_not_present',
  'vulnerable_code_not_in_execute_path',
  'vulnerable_code_cannot_be_controlled_by_adversary',
  'inline_mitigations_already_exist',
]);
const day = 86400000;

/** Reject without reflecting any private assessment or evidence value. */
function refuse() {
  throw Error('Release finding gate refused');
}
/** Require a closed object at an authority-bearing input boundary. */
function object(value, allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    refuse();
}
/** Test an attributable identifier or evidence reference without interpreting its text. */
function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
/** Decode canonical UTC dates without normalizing malformed dates into another day. */
function date(value) {
  if (typeof value !== 'string') refuse();
  const result = Date.parse(value);
  if (!Number.isFinite(result) || new Date(result).toISOString() !== value) refuse();
  return result;
}
/** Validate a nonempty advisory set; aliases remain explicit and case-sensitive. */
function advisories(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(text) ||
    new Set(value).size !== value.length
  )
    refuse();
}
/** Validate the exact material/component binding shared by a finding and its record. */
function binding(value) {
  if (!text(value.id) || !/^sha256:[a-f0-9]{64}$/u.test(value.artifact)) refuse();
  object(value.component, ['purl', 'location']);
  if (
    !text(value.component.purl) ||
    !value.component.purl.startsWith('pkg:') ||
    !text(value.component.location)
  )
    refuse();
  advisories(value.advisoryIds);
  if (!classes.has(value.class) || typeof value.knownExploited !== 'boolean') refuse();
}
/** Require one current private row rather than manufacturing an approval from absent data. */
function recordShape(record) {
  object(record, [
    'id',
    'artifact',
    'component',
    'advisoryIds',
    'class',
    'knownExploited',
    'reachability',
    'status',
    'openedAt',
    'dueAt',
    'decision',
    'decider',
    'links',
  ]);
  binding(record);
  if (!statuses.has(record.status)) refuse();
  date(record.openedAt);
  date(record.dueAt);
  object(record.reachability, ['judgment', 'evidence', 'author', 'reviewer']);
  if (
    !['unknown', 'reachable', 'unreachable'].includes(record.reachability.judgment) ||
    !Array.isArray(record.reachability.evidence) ||
    !record.reachability.evidence.every(text)
  )
    refuse();
  if (!Array.isArray(record.links) || !record.links.every(text)) refuse();
  if (record.decider !== undefined && record.decider !== null) {
    object(record.decider, ['id', 'role']);
    if (!text(record.decider.id) || !roles.has(record.decider.role)) refuse();
  }
  if (record.decision !== undefined && record.decision !== null) {
    object(record.decision, ['at', 'reviewAt', 'reason', 'control', 'justification']);
    date(record.decision.at);
    if (record.decision.reviewAt !== undefined) date(record.decision.reviewAt);
  }
}
/** One scanner identity may occur in several platform artifacts or component locations. */
function scopedIdentity(value) {
  return JSON.stringify([value.id, value.artifact, value.component.purl, value.component.location]);
}
/** Compare the complete artifact/component/advisory binding, not just the vulnerability id. */
function sameBinding(finding, record) {
  return (
    finding.id === record.id &&
    finding.artifact === record.artifact &&
    finding.component.purl === record.component.purl &&
    finding.component.location === record.component.location &&
    JSON.stringify([...finding.advisoryIds].sort()) ===
      JSON.stringify([...record.advisoryIds].sort())
  );
}
/** Validate one of the three admitted K/C closure profiles at the explicit current clock. */
function cleared(record, now) {
  const decision = record.decision;
  if (!decision || !record.decider || date(decision.at) > now) refuse();
  if (decision.reviewAt !== undefined && date(decision.reviewAt) <= now) refuse();
  switch (record.status) {
    case 'mitigated': {
      object(decision.control, ['commit', 'setting']);
      const { commit, setting } = decision.control;
      if (commit === undefined && setting === undefined) refuse();
      if (commit !== undefined && !/^[a-f0-9]{40}$/u.test(commit)) refuse();
      if (setting !== undefined && !text(setting)) refuse();
      if (date(decision.reviewAt) <= now) refuse();
      return;
    }
    case 'not_affected': {
      const { author, reviewer, evidence } = record.reachability;
      if (
        !justifications.has(decision.justification) ||
        !text(author) ||
        !text(reviewer) ||
        author === reviewer ||
        evidence.length === 0
      )
        refuse();
      return;
    }
    case 'accepted':
      if (
        record.decider.role !== 'engineer' ||
        !text(decision.reason) ||
        date(decision.reviewAt) <= now ||
        date(decision.reviewAt) > date(decision.at) + 90 * day
      )
        refuse();
      return;
    default:
      refuse();
  }
}
/**
 * Admit only current mitigated, independently reviewed not-affected, or engineer-accepted K/C rows.
 * Absence of the engineer-controlled export means no approvals, never an implicit clearance.
 * @param {{findings: object[], register?: object, now: number}} input Exact scanner projections and private export.
 */
export function assertReleaseFindingGate({ findings, register, now }) {
  if (!Array.isArray(findings) || !Number.isFinite(now)) refuse();
  const publicIds = new Set();
  let records = [];
  if (register !== undefined) {
    object(register, ['schemaVersion', 'records']);
    if (register.schemaVersion !== 1 || !Array.isArray(register.records)) refuse();
    records = register.records;
    records.forEach(recordShape);
    if (new Set(records.map(scopedIdentity)).size !== records.length) refuse();
  }
  for (const finding of findings) {
    object(finding, [
      'id',
      'artifact',
      'component',
      'advisoryIds',
      'class',
      'knownExploited',
      'fixAvailable',
    ]);
    binding(finding);
    if (finding.fixAvailable !== undefined && typeof finding.fixAvailable !== 'boolean') refuse();
    const previous = records.find((record) => scopedIdentity(record) === scopedIdentity(finding));
    // Current exploitation facts or a prior urgent class cannot be lowered by a stale label.
    const urgent =
      finding.knownExploited ||
      ['K', 'C'].includes(finding.class) ||
      previous?.knownExploited ||
      ['K', 'C'].includes(previous?.class);
    if (!urgent) continue;
    if (!previous || !sameBinding(finding, previous)) refuse();
    cleared(previous, now);
    finding.advisoryIds.forEach((id) => {
      publicIds.add(id);
    });
  }
  return [...publicIds].sort();
}

/** Existing public Markdown record; no assessment, reviewer or private evidence is projected. */
export function releaseFindingRecord(input) {
  const ids = assertReleaseFindingGate(input);
  return `\n- Present K/C advisory ids (current finding admission passed): ${ids.length ? JSON.stringify(ids) : 'none'}.\n`;
}
