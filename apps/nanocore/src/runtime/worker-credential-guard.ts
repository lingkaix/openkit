import { createHash } from 'node:crypto';
import { ArtifactAuthorityError } from '../lib/store.js';

/** Backend-private comparison evidence for one original worker materialization. */
export interface WorkerCredentialCheckValues {
  /** Exact injected values requiring literal comparison rather than token hash checks. */
  sensitiveValues: string[];
  /** SHA-256 over each session loopback credential's 43 encoded UTF-8 bytes. */
  loopbackDigests: [string, string];
  /** Original lease-bound SHA-256 hashes over the route tokens' decoded 32 bytes. */
  routeTokenHashes: { workerControl: string; inference: string; capability: string };
}

const localSimulatorEvidenceBrand = Symbol('local-simulator-no-credential-injection');

/** Private proof for the deterministic local simulator, which injects no credentials. */
export interface LocalSimulatorCredentialCheckValues {
  /** Process-private identity; worker JSONL or collection cannot construct this evidence. */
  readonly [localSimulatorEvidenceBrand]: true;
}

const localSimulatorEvidence: LocalSimulatorCredentialCheckValues = Object.freeze({
  [localSimulatorEvidenceBrand]: true as const,
});

/** Declares the simulator's known credential-free execution path. @returns Private local evidence, never Worker collection evidence. */
export function createLocalSimulatorCredentialCheckValues(): LocalSimulatorCredentialCheckValues {
  return localSimulatorEvidence;
}

/** Requires the local constructor's proof. @param evidence Simulator-private evidence. @returns Validated local proof. */
export function requireLocalSimulatorCredentialCheckValues(
  evidence: unknown
): LocalSimulatorCredentialCheckValues {
  if (evidence !== localSimulatorEvidence) {
    throw new ArtifactAuthorityError(
      'recovery_required',
      'Local simulator credential evidence is unavailable.'
    );
  }
  return localSimulatorEvidence;
}

/** Complete evidence for either supported execution path; Worker collection uses only WorkerCredentialCheckValues. */
export type CredentialCheckValues =
  | WorkerCredentialCheckValues
  | LocalSimulatorCredentialCheckValues;

/** One contiguous, end-exclusive byte range containing exact injected credential material. */
export interface WorkerCredentialMatch {
  /** First matched byte. */
  start: number;
  /** First byte after the match. */
  end: number;
}

/**
 * Requires complete private evidence; absence is never permission to skip comparison.
 * @param evidence Evidence supplied by the injection/collection owner, never worker content.
 * @returns Complete evidence after structural validation.
 * @throws ArtifactAuthorityError with recovery_required when evidence is unavailable or contradictory.
 */
export function requireWorkerCredentialCheckValues(evidence: unknown): WorkerCredentialCheckValues {
  const values = evidence as WorkerCredentialCheckValues | null | undefined;
  const routeHashes = values?.routeTokenHashes;
  const routes = [routeHashes?.workerControl, routeHashes?.inference, routeHashes?.capability];
  if (
    !Array.isArray(values?.sensitiveValues) ||
    !values.sensitiveValues.every((value) => typeof value === 'string') ||
    !Array.isArray(values.loopbackDigests) ||
    values.loopbackDigests.length !== 2 ||
    ![...values.loopbackDigests, ...routes].every(
      (digest) => typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest)
    ) ||
    new Set(routes).size !== 3 ||
    new Set(values.loopbackDigests).size !== 2
  ) {
    throw new ArtifactAuthorityError(
      'recovery_required',
      'Original worker credential comparison evidence is unavailable or contradictory.'
    );
  }
  return values;
}

/**
 * Finds exact literal and hash-proven matches, coalescing overlapping or adjacent ranges.
 * @param bytes Unmodified candidate bytes; no decoding or normalization is performed on them.
 * @param evidence Validated execution-specific private evidence.
 * @returns Ordered disjoint ranges, usable for Artifact rejection or Item replacement.
 */
export function findWorkerCredentialMatches(
  bytes: Buffer,
  evidence: CredentialCheckValues
): WorkerCredentialMatch[] {
  if (evidence === localSimulatorEvidence) return [];
  const values = requireWorkerCredentialCheckValues(evidence);
  const matches: WorkerCredentialMatch[] = [];
  for (const value of new Set(values.sensitiveValues.filter((value) => value.length > 0))) {
    const literal = Buffer.from(value, 'utf8');
    let start = bytes.indexOf(literal);
    while (start !== -1) {
      appendMatch(matches, start, start + literal.length);
      start = bytes.indexOf(literal, start + 1);
    }
  }
  const loopbackDigests = new Set(values.loopbackDigests);
  const routeHashes = new Set([
    values.routeTokenHashes.workerControl,
    values.routeTokenHashes.inference,
    values.routeTokenHashes.capability,
  ]);
  let alphabetRun = 0;
  for (let end = 1; end <= bytes.length; end += 1) {
    alphabetRun = isCredentialAlphabetByte(bytes[end - 1]!) ? alphabetRun + 1 : 0;
    if (alphabetRun < 43) continue;
    const start = end - 43;
    const window = bytes.subarray(start, end);
    if (loopbackDigests.has(createHash('sha256').update(window).digest('hex'))) {
      appendMatch(matches, start, end);
    }
    const spelling = window.toString('ascii');
    const decoded = Buffer.from(spelling, 'base64url');
    // Route hashes cover decoded bytes, but only the injected canonical spelling is literal evidence.
    if (
      decoded.length === 32 &&
      decoded.toString('base64url') === spelling &&
      routeHashes.has(createHash('sha256').update(decoded).digest('hex'))
    ) {
      appendMatch(matches, start, end);
    }
  }
  matches.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: WorkerCredentialMatch[] = [];
  for (const match of matches) appendMatch(merged, match.start, match.end);
  return merged;
}

/** Appends or extends an ordered range. @param matches Ranges collected so far. @param start First byte. @param end End-exclusive byte. */
function appendMatch(matches: WorkerCredentialMatch[], start: number, end: number): void {
  const previous = matches.at(-1);
  if (previous && previous.start <= start && previous.end >= start) {
    previous.end = Math.max(previous.end, end);
  } else {
    matches.push({ start, end });
  }
}

/** Tests the exact credential alphabet. @param byte Encoded byte. @returns Whether it can occur in an unpadded base64url token. */
function isCredentialAlphabetByte(byte: number): boolean {
  return (
    (byte >= 65 && byte <= 90) ||
    (byte >= 97 && byte <= 122) ||
    (byte >= 48 && byte <= 57) ||
    byte === 45 ||
    byte === 95
  );
}
