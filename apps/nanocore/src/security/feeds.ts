import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { Agent, fetch as fetchWithDispatcher } from 'undici';
import type { InventoryComponent, SecurityInventory } from './inventory.js';

/** Release-authored feed limits. No caller can weaken the accepted E3 bounds. */
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const REQUEST_MS = 60_000;
const RUN_MS = 300_000;
const connector = new Agent({ connect: { timeout: 10_000 } });

/** A transient finding; the existing trigger owns persistence and human dispositions. */
export interface SecurityFinding {
  readonly sourceId: string;
  readonly purl: string;
  readonly version: string;
  readonly advisoryId: string;
  readonly aliases: string[];
  readonly class: 'K' | 'C' | 'H' | 'N';
  readonly status: 'open' | 'mitigated' | 'fixed' | 'not_affected' | 'accepted';
  readonly firstMatchedAt: string;
  readonly dueAt: string | null;
  readonly triageRevision: number;
}

/** An explicit assessment limitation; it is never an invented package match. */
export interface SecurityAssessmentGap {
  readonly kind: string;
  readonly reason: string;
  readonly identifier?: string;
}

/** Only verified identifiers from a source parser have enrichment meaning. Text has none. */
export interface SecurityRssSignal {
  readonly feedId: string;
  readonly identifiers: readonly string[];
  readonly text?: string;
}

/** Minimal validated OSV record; untrusted optional content is narrowed at use. */
export interface OsvRecord {
  readonly id: string;
  readonly affected: readonly unknown[];
  readonly aliases?: unknown;
  readonly severity?: unknown;
  readonly database_specific?: unknown;
  readonly [key: string]: unknown;
}

/** WHATWG fetch port with an explicit adapter-owned connection-establishment bound. */
export type SecurityFeedFetch = (
  input: string,
  init: Omit<RequestInit, 'signal' | 'redirect'> & {
    readonly signal: AbortSignal;
    readonly redirect: 'manual';
    readonly connectTimeoutMs: number;
  }
) => Promise<Response>;

/** Result from a bounded feed step, not a proof that any component is safe. */
export interface SecurityFeedDocument {
  readonly records: OsvRecord[];
  readonly identifiers: string[];
  coverage: 'complete' | 'incomplete' | 'unavailable';
  malformedRecords: number;
}

const RANK = { N: 0, H: 1, C: 2, K: 3 } as const;
const HOURS = { K: 24, C: 72, H: 168, N: null } as const;

/**
 * Matches OSV against exact inventory, then applies raise-only KEV/RSS enrichment.
 * Source disappearance and untrusted prose never clear a finding or reset its clock.
 * Only a complete inventory observation proves removal of a matched version.
 *
 * @param input One feed's current records, prior findings and current enrichment observations.
 * @returns Transient findings, explicit gaps and malformed-record count for the trigger owner.
 */
export function assessAdvisories(input: {
  readonly inventory: SecurityInventory;
  readonly records: readonly unknown[];
  readonly previous: readonly SecurityFinding[];
  readonly kev: unknown;
  readonly rss: readonly SecurityRssSignal[];
  readonly now: string;
}): { findings: SecurityFinding[]; gaps: SecurityAssessmentGap[]; malformedRecords: number } {
  if (!Number.isFinite(Date.parse(input.now))) throw new TypeError('Assessment time is invalid.');
  const gaps: SecurityAssessmentGap[] = [];
  const findings = new Map(input.previous.map((finding) => [findingKey(finding), { ...finding }]));
  const observed = new Set(
    input.inventory.components.map((component) =>
      JSON.stringify([component.sourceId, component.purl, component.version])
    )
  );
  const present = (finding: SecurityFinding) =>
    observed.has(JSON.stringify([finding.sourceId, finding.purl, finding.version]));
  const packageIndex = new Map<string, InventoryComponent[]>();
  for (const component of input.inventory.components) {
    for (const key of componentKeys(component)) {
      const rows = packageIndex.get(key) ?? [];
      rows.push(component);
      packageIndex.set(key, rows);
    }
  }
  for (const [key, finding] of findings) {
    const complete = input.inventory.coverage.some(
      (row) => row.sourceId === finding.sourceId && row.status === 'complete'
    );
    if (complete && !present(finding) && finding.status !== 'fixed')
      findings.set(key, {
        ...finding,
        status: 'fixed',
        triageRevision: finding.triageRevision + 1,
      });
    else if (present(finding) && finding.status === 'fixed')
      findings.set(key, { ...finding, status: 'open', triageRevision: finding.triageRevision + 1 });
  }
  let malformedRecords = 0;
  let matchChecks = 0;
  records: for (const candidate of input.records.slice(0, MAX_RECORDS)) {
    if (!isOsv(candidate)) {
      malformedRecords++;
      continue;
    }
    const aliases = stringList(candidate.aliases);
    const severity = findingClass(candidate, gaps);
    for (const affected of candidate.affected) {
      const components = new Set(
        affectedKeys(affected).flatMap((key) => packageIndex.get(key) ?? [])
      );
      for (const component of components) {
        if (++matchChecks > 1_000_000 || findings.size >= MAX_RECORDS) {
          gaps.push({
            kind: 'incomplete',
            reason: 'Advisory assessment work or finding bound reached.',
          });
          break records;
        }
        if (!affects(component, affected, gaps)) continue;
        const key = findingKey({ ...component, advisoryId: candidate.id });
        const previous = findings.get(key);
        const firstMatchedAt = previous?.firstMatchedAt ?? input.now;
        const raised = previous && RANK[severity] > RANK[previous.class];
        const selectedClass = previous && !raised ? previous.class : severity;
        findings.set(key, {
          sourceId: component.sourceId,
          purl: component.purl,
          version: component.version,
          advisoryId: candidate.id,
          aliases: [...new Set([...(previous?.aliases ?? []), ...aliases])],
          class: selectedClass,
          status: previous?.status ?? 'open',
          firstMatchedAt,
          dueAt: dueAt(firstMatchedAt, selectedClass),
          triageRevision: (previous?.triageRevision ?? 1) + (raised ? 1 : 0),
        });
      }
    }
  }
  if (input.records.length > MAX_RECORDS)
    gaps.push({ kind: 'incomplete', reason: 'Advisory record limit reached.' });
  const kevIds = new Set<string>();
  if (object(input.kev) && Array.isArray(input.kev.vulnerabilities))
    for (const row of input.kev.vulnerabilities.slice(0, MAX_RECORDS))
      if (object(row) && typeof row.cveID === 'string') kevIds.add(row.cveID.toUpperCase());
  for (const [key, finding] of findings) {
    if (!present(finding)) continue;
    if ([finding.advisoryId, ...finding.aliases].some((id) => kevIds.has(id.toUpperCase())))
      findings.set(key, raise(finding, 'K'));
  }
  // Index only currently inventory-backed advisories, not package claims from RSS prose.
  const identifiers = new Map<string, Set<string>>();
  for (const finding of findings.values()) {
    if (!present(finding)) continue;
    for (const identifier of [finding.advisoryId, ...finding.aliases]) {
      const ids = identifiers.get(identifier.toUpperCase()) ?? new Set<string>();
      ids.add(finding.advisoryId);
      identifiers.set(identifier.toUpperCase(), ids);
    }
  }
  for (const signal of input.rss.slice(0, MAX_RECORDS)) {
    for (const identifier of signal.identifiers.slice(0, MAX_RECORDS)) {
      const matches = identifiers.get(identifier.toUpperCase());
      if (!matches || matches.size !== 1) {
        gaps.push({
          kind: matches ? 'ambiguous-identifier' : 'unmatched-identifier',
          identifier,
          reason: 'RSS identifier does not select one inventory-backed advisory.',
        });
        continue;
      }
      for (const [key, finding] of findings)
        if (present(finding) && matches.has(finding.advisoryId))
          findings.set(key, raise(finding, 'C'));
    }
  }
  // One assessment has one revision change, even if multiple sources raise the same finding.
  const previous = new Map(input.previous.map((finding) => [findingKey(finding), finding]));
  const revised = [...findings.values()].map((finding) => {
    const old = previous.get(findingKey(finding));
    const changed = old && (RANK[finding.class] > RANK[old.class] || finding.status !== old.status);
    return { ...finding, triageRevision: old ? old.triageRevision + (changed ? 1 : 0) : 1 };
  });
  // Repeated records can name the same unsupported assessment. Keep the report bounded.
  return {
    findings: revised,
    gaps: [
      ...new Map(gaps.slice(0, MAX_RECORDS).map((gap) => [JSON.stringify(gap), gap])).values(),
    ],
    malformedRecords,
  };
}

/** Exact finding identity is per observed artifact source and advisory. */
function findingKey(
  value: Pick<SecurityFinding, 'sourceId' | 'purl' | 'version' | 'advisoryId'>
): string {
  return JSON.stringify([value.sourceId, value.purl, value.version, value.advisoryId]);
}

/** Preserves dispositions and the original class clock when exploitation raises urgency. */
function raise(finding: SecurityFinding, target: SecurityFinding['class']): SecurityFinding {
  return RANK[target] <= RANK[finding.class]
    ? finding
    : {
        ...finding,
        class: target,
        dueAt: dueAt(finding.firstMatchedAt, target),
        triageRevision: finding.triageRevision + 1,
      };
}

/** Derives a stricter deadline from the first match, never from the latest feed read. */
function dueAt(first: string, severity: SecurityFinding['class']): string | null {
  const hours = HOURS[severity];
  return hours === null ? null : new Date(Date.parse(first) + hours * 3_600_000).toISOString();
}

/** Matches only exact package/version facts or explicitly supported OSV range semantics. */
function affects(
  component: InventoryComponent,
  value: unknown,
  gaps: SecurityAssessmentGap[]
): boolean {
  if (!object(value)) return false;
  const versions = stringList(value.versions);
  const ranges = Array.isArray(value.ranges) ? value.ranges : [];
  const git = ranges.filter((range) => object(range) && range.type === 'GIT');
  if (git.length && component.repository && component.releaseTag)
    if (
      git.some((range) => object(range) && range.repo === component.repository) &&
      versions.includes(component.releaseTag)
    )
      return true;
  if (!object(value.package) || !packageMatches(component, value.package)) return false;
  if (versions.includes(component.version)) return true;
  return ranges.some((range) => {
    if (!object(range)) return false;
    if (range.type === 'SEMVER') return semverRange(component.version, range.events, gaps);
    if (range.type !== 'GIT')
      gaps.push({
        kind: 'unsupported-range',
        reason: 'Affected range is not an exact version, SEMVER range or release-tag GIT range.',
      });
    return false;
  });
}

const ECOSYSTEM_TYPES: Record<string, string> = {
  npm: 'npm',
  PyPI: 'pypi',
  'crates.io': 'cargo',
  Go: 'golang',
  Maven: 'maven',
  NuGet: 'nuget',
  Packagist: 'composer',
  RubyGems: 'gem',
  Hex: 'hex',
  Pub: 'pub',
  Hackage: 'hackage',
};

/** Removes only a version; ecosystem, namespace, qualifiers and subpath remain identity. */
function purlIdentity(purl: string): string {
  const end = purl.search(/[?#]/);
  const prefix = end < 0 ? purl : purl.slice(0, end);
  const at = prefix.lastIndexOf('@');
  return at < 0 ? purl : prefix.slice(0, at) + (end < 0 ? '' : purl.slice(end));
}
/** Builds lookup keys once so hostile advisory cross-products do not scan the whole inventory. */
function componentKeys(component: InventoryComponent): string[] {
  const identity = purlIdentity(component.purl);
  const keys = [`purl:${identity}`];
  const match = /^pkg:([^/]+)\/(.+)$/.exec(identity.split(/[?#]/, 1)[0]!);
  try {
    if (match) keys.push(`package:${match[1]}:${decodeURIComponent(match[2]!)}`);
  } catch {
    /* Inventory admission already reports malformed package identities. */
  }
  if (component.repository) keys.push(`git:${component.repository}`);
  return keys;
}
/** Selects exact candidate identities, never names extracted from advisory prose. */
function affectedKeys(value: unknown): string[] {
  if (!object(value)) return [];
  const keys: string[] = [];
  if (object(value.package)) {
    const pkg = value.package;
    if (typeof pkg.purl === 'string') keys.push(`purl:${purlIdentity(pkg.purl)}`);
    else if (
      typeof pkg.ecosystem === 'string' &&
      typeof pkg.name === 'string' &&
      ECOSYSTEM_TYPES[pkg.ecosystem]
    )
      keys.push(
        `package:${ECOSYSTEM_TYPES[pkg.ecosystem]}:${pkg.ecosystem === 'Maven' ? pkg.name.replace(':', '/') : pkg.name}`
      );
  }
  if (Array.isArray(value.ranges))
    for (const range of value.ranges)
      if (object(range) && range.type === 'GIT' && typeof range.repo === 'string')
        keys.push(`git:${range.repo}`);
  return keys;
}

/** Keeps qualifiers/subpath for purl identities; ecosystem names are never display names. */
function packageMatches(component: InventoryComponent, pkg: Record<string, unknown>): boolean {
  if (typeof pkg.purl === 'string') return purlIdentity(component.purl) === purlIdentity(pkg.purl);
  if (typeof pkg.ecosystem !== 'string' || typeof pkg.name !== 'string') return false;
  const match = /^pkg:([^/]+)\/(.+)$/.exec(purlIdentity(component.purl).split(/[?#]/, 1)[0]!);
  if (!match || match[1] !== ECOSYSTEM_TYPES[pkg.ecosystem]) return false;
  try {
    const name = decodeURIComponent(match[2]!);
    return name === (pkg.ecosystem === 'Maven' ? pkg.name.replace(':', '/') : pkg.name);
  } catch {
    return false;
  }
}

type Semver = { core: bigint[]; pre: string[] };
/** Parses strict SemVer; build metadata never changes precedence. */
function semver(value: string): Semver | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value
    );
  if (!match) return null;
  const pre = match[4]?.split('.') ?? [];
  if (pre.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))
    return null;
  return { core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)], pre };
}
/** Compares SemVer numeric components and prerelease identifiers without lexical number errors. */
function compare(a: Semver, b: Semver): number {
  for (let n = 0; n < 3; n++) if (a.core[n] !== b.core[n]) return a.core[n]! < b.core[n]! ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let n = 0; n < Math.max(a.pre.length, b.pre.length); n++) {
    const x = a.pre[n];
    const y = b.pre[n];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
/** Evaluates OSV ordered disjoint intervals, including exclusive limit and inclusive last_affected. */
function semverRange(version: string, events: unknown, gaps: SecurityAssessmentGap[]): boolean {
  const current = semver(version);
  if (!current || !Array.isArray(events)) {
    gaps.push({
      kind: 'unsupported-version',
      reason: 'SEMVER assessment lacks a valid version or event sequence.',
    });
    return false;
  }
  let start: Semver | 'zero' | undefined;
  let matched = false;
  for (const event of events) {
    if (!object(event) || Object.keys(event).length !== 1) return false;
    const [kind, value] = Object.entries(event)[0]!;
    if (typeof value !== 'string') return false;
    if (kind === 'introduced') {
      if (start !== undefined) return false;
      start = value === '0' ? 'zero' : (semver(value) ?? undefined);
      if (start === undefined) return false;
    } else if (['fixed', 'last_affected', 'limit'].includes(kind)) {
      const end = semver(value);
      if (start === undefined || !end) return false;
      const lower = start === 'zero' || compare(current, start) >= 0;
      const upper = compare(current, end);
      if (lower && (upper < 0 || (kind === 'last_affected' && upper === 0))) matched = true;
      start = undefined;
    } else return false;
  }
  return matched || (start !== undefined && (start === 'zero' || compare(current, start) >= 0));
}

/** Uses only structured severity fields. Unsupported vectors remain explicitly unassessed. */
function findingClass(record: OsvRecord, gaps: SecurityAssessmentGap[]): SecurityFinding['class'] {
  if (record.id.startsWith('MAL-')) return 'K';
  let rating: SecurityFinding['class'] | undefined;
  const specific = object(record.database_specific) ? record.database_specific : null;
  if (typeof specific?.severity === 'string') {
    const name = specific.severity.toUpperCase();
    rating =
      name === 'CRITICAL'
        ? 'C'
        : name === 'HIGH'
          ? 'H'
          : ['MODERATE', 'MEDIUM', 'LOW', 'NONE'].includes(name)
            ? 'N'
            : undefined;
  }
  if (Array.isArray(record.severity))
    for (const metric of record.severity) {
      if (!object(metric) || typeof metric.score !== 'string') continue;
      const score = cvssScore(metric.score);
      if (score === null) {
        gaps.push({
          kind: 'unsupported-severity',
          identifier: record.id,
          reason: 'Severity vector requires a supported structured score or a person assessment.',
        });
        continue;
      }
      const level = score >= 9 ? 'C' : score >= 7 ? 'H' : 'N';
      if (!rating || RANK[level] > RANK[rating]) rating = level;
    }
  return rating ?? 'H';
}

/** Computes CVSS v3 base severity; numeric scores are accepted only as bounded structured scores. */
function cvssScore(vector: string): number | null {
  if (/^(?:10(?:\.0)?|[0-9](?:\.\d)?)$/.test(vector)) return Number(vector);
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;
  const parts = vector
    .split('/')
    .slice(1)
    .map((part) => part.split(':'));
  if (
    parts.some((part) => part.length !== 2) ||
    new Set(parts.map((part) => part[0])).size !== parts.length
  )
    return null;
  const values = Object.fromEntries(parts);
  const changed = values.S === 'C';
  if (!['U', 'C'].includes(values.S ?? '')) return null;
  const av = ({ N: 0.85, A: 0.62, L: 0.55, P: 0.2 } as Record<string, number>)[values.AV ?? ''];
  const ac = ({ L: 0.77, H: 0.44 } as Record<string, number>)[values.AC ?? ''];
  const pr = (
    (changed ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 }) as Record<
      string,
      number
    >
  )[values.PR ?? ''];
  const ui = ({ N: 0.85, R: 0.62 } as Record<string, number>)[values.UI ?? ''];
  const impacts = ['C', 'I', 'A'].map(
    (key) => (({ H: 0.56, L: 0.22, N: 0 }) as Record<string, number>)[values[key] ?? '']
  );
  if ([av, ac, pr, ui, ...impacts].some((value) => value === undefined)) return null;
  const iss = 1 - (1 - impacts[0]!) * (1 - impacts[1]!) * (1 - impacts[2]!);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  return (
    Math.ceil(
      (Math.min((changed ? 1.08 : 1) * (impact + 8.22 * av! * ac! * pr! * ui!), 10) - 1e-10) * 10
    ) / 10
  );
}

/** Narrows JSON records without treating optional text as instructions. */
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Admits the minimum closed OSV core; individual optional fields are narrowed at use. */
function isOsv(value: unknown): value is OsvRecord {
  return (
    object(value) &&
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    Array.isArray(value.affected)
  );
}
/** Selects string identifiers from optional untrusted arrays. */
function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && !!item.trim())
    : [];
}

/**
 * Reads one bounded configured feed without following item links or resolving XML entities.
 * The production adapter enforces the connection bound; total time includes body reads.
 *
 * @param input Configured feed location and optional fixture transport.
 * @returns Observations and explicit coverage loss, never a successful empty failed feed.
 */
export async function readFeedDocument(input: {
  readonly kind: 'osv-records' | 'kev' | 'rss';
  readonly location: string;
  readonly fetch?: SecurityFeedFetch;
}): Promise<SecurityFeedDocument> {
  let raw: RawDocument;
  if (
    input.kind === 'osv-records' &&
    input.location.trim() &&
    !/^[a-z][a-z0-9+.-]*:/i.test(input.location.trim())
  ) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_MS);
    try {
      const stream = createReadStream(input.location);
      const response = new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>);
      raw = await consume(response, input.kind, controller.signal);
    } catch {
      raw = unavailable();
    } finally {
      clearTimeout(timer);
    }
  } else raw = await remote(input.location, input.kind, input.fetch ?? productionFetch);
  return parseDocument(raw, input.kind);
}

/**
 * Discloses the selected inventory to the administrator-configured OSV endpoint.
 * Batch and per-match requests share one five-minute run and never follow redirects.
 *
 * @param input Exact components, confirmed endpoint and optional fixture transport.
 * @returns Bounded full OSV records with explicit partial or failed coverage.
 */
export async function queryOsvApi(input: {
  readonly components: readonly InventoryComponent[];
  readonly endpoint: string;
  readonly fetch?: SecurityFeedFetch;
}): Promise<SecurityFeedDocument> {
  const result: SecurityFeedDocument = {
    records: [],
    identifiers: [],
    coverage: 'complete',
    malformedRecords: 0,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_MS);
  try {
    const endpoint = httpsUrl(input.endpoint);
    if (!endpoint) return { ...result, coverage: 'unavailable' };
    const base = endpoint.href.replace(/\/$/, '');
    const fetch = input.fetch ?? productionFetch;
    const body = JSON.stringify({
      queries: input.components
        .slice(0, MAX_RECORDS)
        .map((component) => ({ package: { purl: component.purl }, version: component.version })),
    });
    if (input.components.length > MAX_RECORDS || Buffer.byteLength(body) > MAX_BYTES)
      return { ...result, coverage: 'incomplete' };
    const batch = await remote(`${base}/v1/querybatch`, 'api', fetch, controller.signal, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (batch.coverage !== 'complete') return { ...result, coverage: batch.coverage };
    let parsed: unknown;
    try {
      parsed = JSON.parse(batch.text);
    } catch {
      return { ...result, coverage: 'incomplete' };
    }
    if (
      !object(parsed) ||
      !Array.isArray(parsed.results) ||
      parsed.results.length !== input.components.length
    )
      return { ...result, coverage: 'incomplete' };
    const ids = new Set<string>();
    for (const entry of parsed.results) {
      if (!object(entry) || (entry.vulns !== undefined && !Array.isArray(entry.vulns))) {
        result.coverage = 'incomplete';
        result.malformedRecords++;
        continue;
      }
      // OSV pagination cannot be mistaken for a complete match set.
      if (entry.next_page_token) result.coverage = 'incomplete';
      for (const match of Array.isArray(entry.vulns) ? entry.vulns : []) {
        if (
          !object(match) ||
          typeof match.id !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(match.id)
        ) {
          result.malformedRecords++;
          result.coverage = 'incomplete';
          continue;
        }
        if (ids.size >= MAX_RECORDS) {
          result.coverage = 'incomplete';
          break;
        }
        ids.add(match.id);
      }
    }
    for (const id of ids) {
      if (controller.signal.aborted) {
        result.coverage = 'incomplete';
        break;
      }
      const raw = await remote(
        `${base}/v1/vulns/${encodeURIComponent(id)}`,
        'osv-records',
        fetch,
        controller.signal,
        {},
        true
      );
      const document = parseDocument(raw, 'osv-records');
      if (document.coverage !== 'complete') result.coverage = 'incomplete';
      result.malformedRecords += document.malformedRecords;
      for (const record of document.records) {
        if (result.records.length >= MAX_RECORDS) {
          result.coverage = 'incomplete';
          break;
        }
        result.records.push(record);
      }
    }
    return result;
  } catch {
    return { ...result, coverage: result.records.length ? 'incomplete' : 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

type DocumentKind = 'osv-records' | 'kev' | 'rss' | 'api';
interface RawDocument {
  text: string;
  prefix: unknown[];
  coverage: SecurityFeedDocument['coverage'];
}

/** Uses the already-installed HTTP adapter to enforce the real 10-second connection limit. */
const productionFetch: SecurityFeedFetch = async (url, init) =>
  (await fetchWithDispatcher(url, { ...init, dispatcher: connector } as Parameters<
    typeof fetchWithDispatcher
  >[1])) as unknown as Response;

/** Refuses credentials and non-HTTPS schemes before making a configured remote request. */
function httpsUrl(location: string): URL | null {
  try {
    const url = new URL(location);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url : null;
  } catch {
    return null;
  }
}
/** Represents a failed source without claiming it returned an empty advisory set. */
function unavailable(): RawDocument {
  return { text: '', prefix: [], coverage: 'unavailable' };
}

/** A single request deadline spans redirects, headers and streamed body consumption. */
async function remote(
  location: string,
  kind: DocumentKind,
  fetch: SecurityFeedFetch,
  runSignal?: AbortSignal,
  init: RequestInit = {},
  noRedirect = false
): Promise<RawDocument> {
  const initial = httpsUrl(location);
  if (!initial || runSignal?.aborted) return unavailable();
  let url: URL = initial;
  const origin = url.origin;
  const controller = new AbortController();
  const abort = () => controller.abort();
  runSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, REQUEST_MS);
  try {
    for (let redirects = 0; ; redirects++) {
      if (controller.signal.aborted) return unavailable();
      const response = await abortable(
        fetch(url.href, {
          ...init,
          redirect: 'manual',
          signal: controller.signal,
          connectTimeoutMs: 10_000,
        }),
        controller.signal
      );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        if (noRedirect || kind === 'api' || redirects >= 3) return unavailable();
        const target = response.headers.get('location');
        const next = target ? httpsUrl(new URL(target, url).href) : null;
        if (!next || next.origin !== origin) return unavailable();
        url = next;
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return unavailable();
      }
      return await consume(response, kind, controller.signal);
    }
  } catch {
    return unavailable();
  } finally {
    clearTimeout(timer);
    runSignal?.removeEventListener('abort', abort);
  }
}

/** Resolves on deadline even if a faulty transport ignores cancellation. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Feed deadline reached.'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Feed deadline reached.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Streams bounded bytes and recognizes top-level OSV array records before an unbounded tail. */
async function consume(
  response: Response,
  kind: DocumentKind,
  signal: AbortSignal
): Promise<RawDocument> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', prefix: [], coverage: 'incomplete' };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  const scanner = new ArrayPrefix();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_BYTES) {
      void reader.cancel().catch(() => {});
      return { text, prefix: [], coverage: 'incomplete' };
    }
    while (true) {
      const row = await abortable(reader.read(), signal);
      if (signal.aborted) return { text, prefix: scanner.rows, coverage: 'incomplete' };
      if (row.done) break;
      bytes += row.value.byteLength;
      if (bytes > MAX_BYTES) {
        void reader.cancel().catch(() => {});
        return { text, prefix: scanner.rows, coverage: 'incomplete' };
      }
      const chunk = decoder.decode(row.value, { stream: true });
      text += chunk;
      if (kind === 'osv-records' && scanner.push(chunk)) {
        void reader.cancel().catch(() => {});
        return { text: '', prefix: scanner.rows, coverage: 'incomplete' };
      }
    }
    text += decoder.decode();
    return { text, prefix: [], coverage: 'complete' };
  } catch {
    void reader.cancel().catch(() => {});
    return { text: '', prefix: scanner.rows, coverage: 'incomplete' };
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Incremental top-level JSON-array framing; final JSON parsing still checks complete syntax. */
class ArrayPrefix {
  readonly rows: unknown[] = [];
  private mode: 'start' | 'array' | 'other' = 'start';
  private item = '';
  private depth = 0;
  private string = false;
  private escape = false;
  private scalar = false;
  private completed = false;
  private count = 0;
  /** Returns true only once the document exceeds its record allowance. */
  push(chunk: string): boolean {
    for (const char of chunk) {
      if (this.mode === 'start') {
        if (/\s/.test(char)) continue;
        this.mode = char === '[' ? 'array' : 'other';
        continue;
      }
      if (this.mode === 'other') continue;
      if (!this.item) {
        if (char === ']') {
          this.mode = 'other';
          continue;
        }
        if (/\s/.test(char) || char === ',') continue;
        this.completed = false;
        this.scalar = char !== '{' && char !== '[' && char !== '"';
      }
      if (this.scalar && this.depth === 0 && !this.string && (char === ',' || char === ']')) {
        if (this.finish()) return true;
        if (char === ']') this.mode = 'other';
        continue;
      }
      this.item += char;
      if (this.string) {
        if (this.escape) this.escape = false;
        else if (char === '\\') this.escape = true;
        else if (char === '"') {
          this.string = false;
          if (this.depth === 0) this.completed = true;
        }
      } else if (char === '"') this.string = true;
      else if (char === '{' || char === '[') this.depth++;
      else if (char === '}' || char === ']') {
        this.depth--;
        if (this.depth === 0) this.completed = true;
      }
      if (this.completed && this.finish()) return true;
    }
    return false;
  }
  /** Counts malformed rows too, so an attacker cannot evade the record bound. */
  private finish(): boolean {
    if (++this.count > MAX_RECORDS) return true;
    try {
      this.rows.push(JSON.parse(this.item));
    } catch {
      this.rows.push(null);
    }
    this.item = '';
    this.completed = false;
    this.scalar = false;
    return false;
  }
}

/** Parses only supported feed structures; malformed neighbors remain counted. */
function parseDocument(
  raw: RawDocument,
  kind: 'osv-records' | 'kev' | 'rss'
): SecurityFeedDocument {
  const result: SecurityFeedDocument = {
    records: [],
    identifiers: [],
    coverage: raw.coverage,
    malformedRecords: 0,
  };
  if (raw.coverage === 'unavailable') return result;
  if (kind === 'rss') {
    if (raw.coverage !== 'complete') return result;
    const parsed = rssIdentifiers(raw.text);
    return {
      ...result,
      identifiers: parsed.identifiers,
      coverage: parsed.complete ? 'complete' : 'incomplete',
      malformedRecords: parsed.complete ? 0 : 1,
    };
  }
  let value: unknown;
  if (raw.prefix.length) value = raw.prefix;
  else
    try {
      value = JSON.parse(raw.text);
    } catch {
      return { ...result, coverage: 'incomplete', malformedRecords: 1 };
    }
  if (kind === 'kev') {
    if (!object(value) || !Array.isArray(value.vulnerabilities))
      return { ...result, coverage: 'incomplete', malformedRecords: 1 };
    if (value.vulnerabilities.length > MAX_RECORDS) result.coverage = 'incomplete';
    for (const row of value.vulnerabilities.slice(0, MAX_RECORDS)) {
      if (object(row) && typeof row.cveID === 'string' && /^CVE-\d{4}-\d{4,}$/.test(row.cveID))
        result.identifiers.push(row.cveID);
      else result.malformedRecords++;
    }
  } else {
    const rows = Array.isArray(value) ? value : [value];
    if (rows.length > MAX_RECORDS) result.coverage = 'incomplete';
    for (const row of rows.slice(0, MAX_RECORDS)) {
      if (isOsv(row)) result.records.push(row);
      else result.malformedRecords++;
    }
  }
  if (result.malformedRecords) result.coverage = 'incomplete';
  return result;
}

/** Extracts identifiers from RSS/Atom item text; DTDs/entities and linked requests are forbidden. */
function rssIdentifiers(text: string): { identifiers: string[]; complete: boolean } {
  const identifiers = new Set<string>();
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return { identifiers: [], complete: false };
  const stack: string[] = [];
  let position = 0;
  let root = false;
  let items = 0;
  const add = (body: string) => {
    if (
      !stack.some((tag) => tag === 'item' || tag === 'entry') ||
      ['link', 'guid', 'id'].includes(stack.at(-1) ?? '')
    )
      return;
    const decoded = body
      .replace(/&(?:amp|lt|gt|quot|apos);/g, ' ')
      .replace(/&#(?:x[0-9a-f]+|\d+);/gi, ' ');
    for (const match of decoded.matchAll(
      /\b(?:CVE-\d{4}-\d{4,}|GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}|(?:MAL|RUSTSEC|PYSEC|GO|OSV|GSD)-\d{4}-[A-Za-z0-9.-]+)\b/gi
    )) {
      const id = match[0]!;
      identifiers.add(
        id.toUpperCase().startsWith('GHSA-')
          ? `GHSA-${id.slice(5).toLowerCase()}`
          : id.toUpperCase()
      );
      if (identifiers.size >= MAX_RECORDS) return;
    }
  };
  while (position < text.length) {
    if (
      text.startsWith('<!--', position) ||
      text.startsWith('<?', position) ||
      text.startsWith('<![CDATA[', position)
    ) {
      const cdata = text.startsWith('<![CDATA[', position);
      const start = position + (cdata ? 9 : text.startsWith('<!--', position) ? 4 : 2);
      const endToken = cdata ? ']]>' : text.startsWith('<!--', position) ? '-->' : '?>';
      const end = text.indexOf(endToken, start);
      if (end < 0) return { identifiers: [...identifiers], complete: false };
      if (cdata) add(text.slice(start, end));
      position = end + endToken.length;
      continue;
    }
    if (text[position] !== '<') {
      const next = text.indexOf('<', position);
      const end = next < 0 ? text.length : next;
      const body = text.slice(position, end);
      if (!stack.length && body.trim()) return { identifiers: [...identifiers], complete: false };
      if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(body))
        return { identifiers: [...identifiers], complete: false };
      add(body);
      position = end;
      continue;
    }
    const end = text.indexOf('>', position);
    if (end < 0) return { identifiers: [...identifiers], complete: false };
    const tag = /^<(\/?)([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?\s*(\/?)>$/.exec(
      text.slice(position, end + 1)
    );
    if (!tag) return { identifiers: [...identifiers], complete: false };
    const name = tag[2]!.split(':').at(-1)!.toLowerCase();
    if (tag[1]) {
      if (tag[3] || stack.pop() !== name) return { identifiers: [...identifiers], complete: false };
    } else {
      if (!stack.length) {
        if (root || !['rss', 'feed'].includes(name))
          return { identifiers: [...identifiers], complete: false };
        root = true;
      }
      if (['item', 'entry'].includes(name) && ++items > MAX_RECORDS)
        return { identifiers: [...identifiers], complete: false };
      if (!tag[3]) stack.push(name);
      if (stack.length > 256) return { identifiers: [...identifiers], complete: false };
    }
    position = end + 1;
  }
  return {
    identifiers: [...identifiers],
    complete: root && stack.length === 0 && identifiers.size < MAX_RECORDS,
  };
}
