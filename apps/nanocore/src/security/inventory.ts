import { createHash } from 'node:crypto';

/** An exact package observation, not a package-name or reachability guess. */
export interface InventoryComponent {
  readonly purl: string;
  readonly version: string;
  readonly sourceId: string;
  readonly repository?: string;
  readonly releaseTag?: string | null;
  readonly sourceCommit?: string | null;
}

/** Build metadata supplied by the release-identity owner, never inferred from an SBOM. */
export type InventoryRelease = Omit<InventoryComponent, 'sourceId'>;

/** Exact released attachment bytes; official provenance is selected by the artifact owner. */
export interface InventoryArtifact {
  readonly sourceId: string;
  readonly kind: 'worker' | 'nanohost';
  readonly official: boolean;
  readonly filename: string;
  readonly sbom: string | null;
  readonly sha256sums: string | null;
}

/** Coverage is separate from components so missing data cannot look like a clean scan. */
export interface InventoryCoverage {
  readonly sourceId: string;
  readonly status: 'complete' | 'unavailable' | 'incomplete' | 'not-covered';
  readonly reason: string;
}

/** Transient E2 report; durable reports remain the security trigger owner's responsibility. */
export interface SecurityInventory {
  readonly components: InventoryComponent[];
  readonly coverage: InventoryCoverage[];
}

const MAX_SBOM_BYTES = 32 * 1024 * 1024;
const MAX_SBOM_COMPONENTS = 100_000;
const RESERVED_SOURCES = ['release', 'app', 'mcp', 'skills', 'light-apps', 'plugins'];

/**
 * Reads E2 inventory observations without fetching artifacts or assuming absent coverage.
 * Worker and NanoHost attachments must match their exact SHA256SUMS name and bytes.
 * Derived artifacts and extensions are explicitly outside release package coverage.
 *
 * @param input Admitted build metadata, embedded App SBOM and selected release attachments.
 * @returns Exact component identities and a separate observation for every coverage source.
 */
export function buildInventory(input: {
  readonly release: InventoryRelease | null;
  readonly appSbom: string | null;
  readonly artifacts: readonly InventoryArtifact[];
}): SecurityInventory {
  const report: SecurityInventory = { components: [], coverage: [] };
  if (input.release && validPackage(input.release.purl, input.release.version)) {
    report.components.push({ ...input.release, sourceId: 'release' });
    report.coverage.push({ sourceId: 'release', status: 'complete', reason: '' });
  } else {
    report.coverage.push({
      sourceId: 'release',
      status: 'unavailable',
      reason: 'Build package identity is unavailable; no release version was inferred.',
    });
  }
  appendSbom(report, 'app', input.appSbom);
  const sources = new Set(RESERVED_SOURCES);
  for (const artifact of input.artifacts) {
    if (!artifact.sourceId || sources.has(artifact.sourceId))
      throw new TypeError('Inventory artifact source IDs must be unique and non-reserved.');
    sources.add(artifact.sourceId);
    if (!artifact.official) {
      report.coverage.push({
        sourceId: artifact.sourceId,
        status: 'not-covered',
        reason: 'Derived or unofficial artifacts are not covered by release SBOMs.',
      });
    } else if (!verifiedAttachment(artifact)) {
      report.coverage.push({
        sourceId: artifact.sourceId,
        status: 'unavailable',
        reason: 'Release SBOM bytes or their exact SHA256SUMS verification are unavailable.',
      });
    } else appendSbom(report, artifact.sourceId, artifact.sbom);
  }
  for (const sourceId of ['mcp', 'skills', 'light-apps', 'plugins']) {
    report.coverage.push({
      sourceId,
      status: 'not-covered',
      reason:
        sourceId === 'mcp'
          ? 'The MCP catalog records transports and optional digests, not package identities.'
          : 'Release SBOMs do not cover these independently supplied extensions.',
    });
  }
  return report;
}

/** Verifies one exact attachment; conflicting checksum entries never authorize it. */
function verifiedAttachment(artifact: InventoryArtifact): boolean {
  if (
    artifact.sbom === null ||
    artifact.sha256sums === null ||
    Buffer.byteLength(artifact.sbom) > MAX_SBOM_BYTES ||
    Buffer.byteLength(artifact.sha256sums) > MAX_SBOM_BYTES ||
    !artifact.filename ||
    /[\r\n]/.test(artifact.filename)
  )
    return false;
  const entries = artifact.sha256sums.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(line);
    return match?.[2] === artifact.filename ? [match[1]!.toLowerCase()] : [];
  });
  return (
    entries.length === 1 &&
    entries[0] === createHash('sha256').update(artifact.sbom, 'utf8').digest('hex')
  );
}

/** Appends only validated rows and reports malformed or truncated package coverage. */
function appendSbom(report: SecurityInventory, sourceId: string, text: string | null): void {
  if (text === null) {
    report.coverage.push({ sourceId, status: 'unavailable', reason: 'SBOM is unavailable.' });
    return;
  }
  let document: unknown;
  try {
    if (Buffer.byteLength(text) > MAX_SBOM_BYTES) throw new Error('oversized');
    document = JSON.parse(text);
  } catch {
    report.coverage.push({
      sourceId,
      status: 'incomplete',
      reason: 'SBOM is malformed or exceeds the document bound.',
    });
    return;
  }
  if (
    !isObject(document) ||
    document.bomFormat !== 'CycloneDX' ||
    typeof document.specVersion !== 'string' ||
    !/^1\.[2-7]$/.test(document.specVersion) ||
    !Array.isArray(document.components)
  ) {
    report.coverage.push({
      sourceId,
      status: 'incomplete',
      reason: 'SBOM has an unsupported format or lacks a package list.',
    });
    return;
  }
  const pending: unknown[][] = [document.components];
  const seen = new Set<string>();
  let malformed = 0;
  let count = 0;
  let truncated = false;
  while (pending.length) {
    const rows = pending.pop()!;
    for (const row of rows) {
      if (++count > MAX_SBOM_COMPONENTS) {
        truncated = true;
        break;
      }
      if (!isObject(row) || !validPackage(row.purl, row.version)) {
        malformed += 1;
      } else {
        const purl = row.purl as string;
        const version = row.version as string;
        const key = JSON.stringify([purl, version]);
        if (!seen.has(key)) {
          seen.add(key);
          report.components.push({ purl, version, sourceId });
        }
      }
      if (isObject(row) && row.components !== undefined) {
        if (Array.isArray(row.components)) pending.push(row.components);
        else malformed += 1;
      }
    }
    if (truncated) break;
  }
  report.coverage.push({
    sourceId,
    status: malformed || truncated ? 'incomplete' : 'complete',
    reason:
      malformed || truncated
        ? `SBOM omitted ${malformed} malformed package records.${truncated ? ' Package limit reached.' : ''}`
        : '',
  });
}

/** Validates a versioned purl without normalizing away ecosystem, qualifiers or subpath. */
function validPackage(purl: unknown, version: unknown): boolean {
  if (typeof purl !== 'string' || typeof version !== 'string' || !version.trim()) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Package identities must reject controls.
  if (/[\s\u0000-\u001f\u007f]/.test(purl)) return false;
  const match = /^pkg:([a-z][a-z0-9.+-]*)\/([^?#]+)(?:\?([^#]+))?(?:#(.+))?$/.exec(purl);
  if (!match) return false;
  const separator = match[2]!.lastIndexOf('@');
  if (separator <= 0 || separator === match[2]!.length - 1) return false;
  try {
    const path = match[2]!.slice(0, separator).split('/');
    if (path.some((part) => !part || ['.', '..'].includes(decodeURIComponent(part)))) return false;
    if (decodeURIComponent(match[2]!.slice(separator + 1)) !== version) return false;
    if (match[3]) {
      const keys = new Set<string>();
      for (const qualifier of match[3].split('&')) {
        const equals = qualifier.indexOf('=');
        const key = qualifier.slice(0, equals);
        if (equals <= 0 || !/^[a-z][a-z0-9._-]*$/.test(key) || keys.has(key)) return false;
        if (!decodeURIComponent(qualifier.slice(equals + 1))) return false;
        keys.add(key);
      }
    }
    if (
      match[4]?.split('/').some((part) => !part || ['.', '..'].includes(decodeURIComponent(part)))
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

/** Narrows untrusted JSON before reading package fields. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
