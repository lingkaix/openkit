import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, normalize, parse } from 'node:path';

/** Declared file-backed sink paths for one named credential slot. */
export interface NanoHostCredentialSinkPaths {
  /** Absolute path for the raw `okt_` secret file. */
  readonly secretPath: string;
  /** Absolute path for the non-secret companion metadata file. */
  readonly companionPath: string;
}

/** Input for one proved NanoHost transport Token safe-sink delivery. */
export interface DeliverNanoHostTransportTokenToNamedSlotInput {
  /** Declared execution-host slot receiving the secret. */
  readonly slot: 'A' | 'B';
  /** Declared sink paths for that slot. */
  readonly sink: NanoHostCredentialSinkPaths;
  /** Plaintext `okt_` secret written exactly once to the sink. */
  readonly secret: string;
  /** Durable Token id recorded in companion metadata. */
  readonly tokenId: string;
  /** Issuance generation recorded in companion metadata. */
  readonly issuanceGeneration: number;
  /** Owning NanoHost identity id recorded in companion metadata. */
  readonly identityId: string;
  /** Declared deployment id recorded in companion metadata. */
  readonly deploymentId: string;
  /**
   * Enrollment must pass `exclusive-create`. Issue and rotation must pass `replace`.
   * Callers MUST choose explicitly; there is no default disposition.
   */
  readonly writeDisposition: 'exclusive-create' | 'replace';
}

/** Redacted proof returned after a successful named-slot write. */
export interface NanoHostCredentialSlotWriteResult {
  /** Slot that received the write. */
  readonly slot: 'A' | 'B';
  /** Proven write status. */
  readonly status: 'written';
  /** Issuance generation written into companion metadata. */
  readonly issuanceGeneration: number;
}

/**
 * Companion key names matching `apps/nanohost/src/credential_slots.rs`.
 *
 * Keep these literals identical to the Rust credential-slot owner so NanoCore
 * delivery and NanoHost selection share one on-disk projection.
 */
export const NANOHOST_COMPANION_TOKEN_ID_KEY = 'token_id';
/** Issuance generation companion key. */
export const NANOHOST_COMPANION_ISSUANCE_GENERATION_KEY = 'issuance_generation';
/** Owning NanoHost identity companion key. */
export const NANOHOST_COMPANION_IDENTITY_ID_KEY = 'identity_id';
/** Declared deployment companion key. */
export const NANOHOST_COMPANION_DEPLOYMENT_ID_KEY = 'deployment_id';

/**
 * Writes one NanoHost transport Token to a named execution-host slot.
 *
 * Matches the credential_slots companion projection: raw `okt_` secret file plus
 * non-secret `key=value` companion metadata, both mode `0600`. Exclusive-create
 * requires both paths absent and never cleans a pre-existing slot. Replace
 * overwrites for issue and rotation. Callers that cannot prove this write MUST
 * revoke or leave the Token unusable.
 *
 * @param input Slot, sink paths, secret, companion fields, and write disposition.
 * @returns Redacted slot-result metadata without the raw secret.
 * @throws When the secret is not `okt_` material or the sink write cannot be proved.
 */
export function deliverNanoHostTransportTokenToNamedSlot(
  input: DeliverNanoHostTransportTokenToNamedSlotInput
): NanoHostCredentialSlotWriteResult {
  if (!input.secret.startsWith('okt_') || input.secret.length === 0) {
    throw new Error('NanoHost transport sink requires raw okt_ secret material.');
  }
  if (!Number.isInteger(input.issuanceGeneration) || input.issuanceGeneration < 1) {
    throw new Error('NanoHost transport sink requires a positive issuance generation.');
  }

  assertSafeNanoHostCredentialSink(input.sink);

  const companion = [
    `${NANOHOST_COMPANION_TOKEN_ID_KEY}=${input.tokenId}`,
    `${NANOHOST_COMPANION_ISSUANCE_GENERATION_KEY}=${input.issuanceGeneration}`,
    `${NANOHOST_COMPANION_IDENTITY_ID_KEY}=${input.identityId}`,
    `${NANOHOST_COMPANION_DEPLOYMENT_ID_KEY}=${input.deploymentId}`,
    '',
  ].join('\n');
  if (input.writeDisposition !== 'exclusive-create' && input.writeDisposition !== 'replace') {
    throw new Error('NanoHost transport sink requires an explicit write disposition.');
  }
  const createdByThisCall = new Set<string>();

  try {
    mkdirSync(dirname(input.sink.secretPath), { recursive: true });
    mkdirSync(dirname(input.sink.companionPath), { recursive: true });
    assertSafeNanoHostCredentialSink(input.sink);
    if (input.writeDisposition === 'exclusive-create') {
      assertNanoHostCredentialSlotFilesAbsent(input.sink);
      writeFileSync(input.sink.secretPath, input.secret, { flag: 'wx', mode: 0o600 });
      createdByThisCall.add(input.sink.secretPath);
      chmodSync(input.sink.secretPath, 0o600);
      writeFileSync(input.sink.companionPath, companion, { flag: 'wx', mode: 0o600 });
      createdByThisCall.add(input.sink.companionPath);
      chmodSync(input.sink.companionPath, 0o600);
    } else {
      writeFileSync(input.sink.secretPath, input.secret, { mode: 0o600 });
      chmodSync(input.sink.secretPath, 0o600);
      writeFileSync(input.sink.companionPath, companion, { mode: 0o600 });
      chmodSync(input.sink.companionPath, 0o600);
    }
  } catch (error) {
    if (input.writeDisposition === 'exclusive-create') {
      clearExclusiveCreateWrittenFiles(input.sink, input.tokenId, createdByThisCall);
    } else {
      clearWrittenNanoHostCredentialFiles(input.sink);
    }
    throw new Error(`NanoHost transport named-slot write failed: ${(error as Error).message}`, {
      cause: error,
    });
  }

  return {
    issuanceGeneration: input.issuanceGeneration,
    slot: input.slot,
    status: 'written',
  };
}

/**
 * Clears one named NanoHost credential slot so it no longer holds usable material.
 *
 * Removes the declared secret and companion files when present. Missing paths are
 * treated as already cleared. Used by rotation cutover (clear predecessor) and
 * abort (clear successor) so exactly one slot remains usable at steady state.
 *
 * @param sink Declared sink paths for the slot to clear.
 */
export function clearNanoHostCredentialSlot(sink: NanoHostCredentialSinkPaths): void {
  assertSafeNanoHostCredentialSink(sink);
  for (const path of [sink.secretPath, sink.companionPath]) {
    try {
      unlinkSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new Error(`NanoHost transport named-slot clear failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
  }
}

/**
 * Reads the Token id declared by one configured slot's companion metadata.
 *
 * @param sink Configured slot paths.
 * @returns Declared Token id, or null when the slot is empty or malformed.
 */
export function readNanoHostCredentialSlotTokenId(
  sink: NanoHostCredentialSinkPaths
): string | null {
  assertSafeNanoHostCredentialSink(sink);
  try {
    const line = readFileSync(sink.companionPath, 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith(`${NANOHOST_COMPANION_TOKEN_ID_KEY}=`));
    const tokenId = line?.slice(NANOHOST_COMPANION_TOKEN_ID_KEY.length + 1).trim();
    return tokenId || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(`NanoHost transport companion read failed: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/**
 * Rejects relative, aliased, symlinked, or hard-linked credential sink targets.
 *
 * @param sink Configured slot paths to validate before any write or clear.
 */
function assertSafeNanoHostCredentialSink(sink: NanoHostCredentialSinkPaths): void {
  const paths = [sink.secretPath, sink.companionPath] as const;
  if (
    paths.some((path) => !isAbsolute(path)) ||
    normalize(sink.secretPath) === normalize(sink.companionPath)
  ) {
    throw new Error('NanoHost transport credential sink paths must be absolute and distinct.');
  }

  const existingTargets = paths.flatMap((path) => {
    assertNoSymbolicLinkInPath(path);
    try {
      return [lstatSync(path)];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  });
  if (
    existingTargets.some((stat) => stat.nlink > 1) ||
    (existingTargets.length === 2 &&
      existingTargets[0]!.dev === existingTargets[1]!.dev &&
      existingTargets[0]!.ino === existingTargets[1]!.ino)
  ) {
    throw new Error('NanoHost transport credential sink targets must not be filesystem aliases.');
  }
}

/**
 * Rejects a symbolic link at the target or any existing parent component.
 *
 * @param target Absolute configured target path.
 */
function assertNoSymbolicLinkInPath(target: string): void {
  const root = parse(target).root;
  let current = normalize(target);
  while (current !== root) {
    try {
      if (dirname(current) !== root && lstatSync(current).isSymbolicLink()) {
        throw new Error('NanoHost transport credential sink paths must not contain symlinks.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    current = dirname(current);
  }
}

/**
 * Rejects a named-slot write when either declared path already exists.
 *
 * @param sink Configured slot paths that must both be absent.
 */
function assertNanoHostCredentialSlotFilesAbsent(sink: NanoHostCredentialSinkPaths): void {
  for (const path of [sink.secretPath, sink.companionPath]) {
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    throw new Error('NanoHost transport named-slot write requires both files absent.');
  }
}

/**
 * Clears only files this exclusive-create call actually created, and only when
 * the companion still proves the attempted Token. Preflight EEXIST leaves the
 * pre-existing slot untouched, including a same-token companion. Partial or
 * unproved files are left in place so the slot stays blocked.
 *
 * @param sink Configured slot paths.
 * @param tokenId Exact Token id this write attempted to install.
 * @param createdByThisCall Paths this call created before failing.
 */
function clearExclusiveCreateWrittenFiles(
  sink: NanoHostCredentialSinkPaths,
  tokenId: string,
  createdByThisCall: ReadonlySet<string>
): void {
  if (createdByThisCall.size === 0) {
    return;
  }

  let owned = false;
  try {
    owned = readNanoHostCredentialSlotTokenId(sink) === tokenId;
  } catch {
    return;
  }
  if (!owned) {
    return;
  }

  for (const path of createdByThisCall) {
    try {
      if (!lstatSync(path).isSymbolicLink()) {
        unlinkSync(path);
      }
    } catch {
      // The original sink error remains authoritative; an unproved cleanup is not reported as success.
    }
  }
}

/**
 * Removes partial files after a failed replace write without following symbolic links.
 *
 * @param sink Configured slot paths whose partial files may exist.
 */
function clearWrittenNanoHostCredentialFiles(sink: NanoHostCredentialSinkPaths): void {
  for (const path of [sink.secretPath, sink.companionPath]) {
    try {
      if (!lstatSync(path).isSymbolicLink()) {
        unlinkSync(path);
      }
    } catch {
      // The original sink error remains authoritative; an unproved cleanup is not reported as success.
    }
  }
}

/**
 * Removes only files still proved to belong to the attempted Token id.
 *
 * Missing, malformed, replaced, or differently owned companions are left in
 * place so a failed writer cannot delete another attempt's slot. Used by
 * enrollment transaction-failure cleanup. Rotation abort and decommission keep
 * the unconditional slot clear.
 *
 * @param sink Configured slot paths whose partial files may exist.
 * @param tokenId Exact Token id this write attempted to install.
 */
export function clearExactOwnedNanoHostCredentialSlot(
  sink: NanoHostCredentialSinkPaths,
  tokenId: string
): void {
  let owned = false;
  try {
    owned = readNanoHostCredentialSlotTokenId(sink) === tokenId;
  } catch {
    return;
  }
  if (!owned) {
    return;
  }

  for (const path of [sink.secretPath, sink.companionPath]) {
    try {
      if (!lstatSync(path).isSymbolicLink()) {
        unlinkSync(path);
      }
    } catch {
      // The original sink error remains authoritative; an unproved cleanup is not reported as success.
    }
  }
}
