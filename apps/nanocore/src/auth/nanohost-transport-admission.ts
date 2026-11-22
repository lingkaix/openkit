import type { Http2Session } from 'node:http2';
import type { OpenKitNanoHostConfig } from '@openkit/config-schema';
import type Database from 'better-sqlite3';
import type { Context, Hono } from 'hono';
import { asApiError, asInvalidRequestError } from '../api-errors.js';
import {
  type AllocateNanoHostRuntimeTargetConnectionGenerationInput,
  allocateNanoHostRuntimeTargetConnectionGeneration,
  type NanoHostRuntimeTargetRecord,
  type RecordNanoHostRuntimeTargetConnectionCloseInput,
  recordNanoHostRuntimeTargetConnectionClose,
} from '../runtime/nanohost-runtime-target.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import {
  type AdmittedNanoHostTransportStorage,
  afterAdmittedNanoHostAcknowledgement,
  transitionAdmittedNanoHostRuntimeTarget,
} from '../storage/nanohost-transport-owner.js';
import type { StorageResult } from '../storage/storage-owner.js';
import type { AuthVariables } from './middleware.js';
import transportRevision from './nanohost-transport-revision.json' with { type: 'json' };
import type { NanoHostTransportSessionAuthority } from './nanohost-transport-session.js';
import {
  consumeNanoHostPhysicalConnectionAdmission,
  isNanoHostPhysicalConnectionContext,
  readNanoHostPhysicalConnectionContext,
} from './nanohost-transport-session.js';
import { evaluateNanoHostTransportTokenUsability } from './nanohost-transport-token.js';
import {
  getNanoHostTransportTokenRecord,
  isNanoHostTransportIdentityActive,
  type NanoHostTransportTokenRecord,
  prepareNanoHostTransportVerification,
  verifyNanoHostTransportTokenRecord,
} from './nanohost-transport-token-store.js';

/** Input for admitting one native NanoHost physical connection. */
export interface AdmitNanoHostTransportConnectionInput {
  /** Presented NanoHost transport Token secret. */
  readonly secret: string;
  /** Opaque physical connection from the native HTTP/2 server context. */
  readonly physicalConnection: object | null;
  /** Exact compiled transport revision presented on the native admission header. */
  readonly transportRevision: string | undefined;
  /** Durable RuntimeTarget id selected by deployment configuration. */
  readonly targetId?: string;
  /** Optional verification clock. */
  readonly now?: Date;
  /** Cancellation of the original admission request. */
  readonly signal?: AbortSignal;
  /** Optional last-use channel label. */
  readonly channel?: string;
  /** Optional last-use source summary. */
  readonly source?: string;
}

/** Successful production admission result. */
export interface AdmitNanoHostTransportConnectionSuccess {
  /** Admission succeeded. */
  readonly ok: true;
  /** Verified token id. */
  readonly tokenId: string;
  /** Configured NanoHost identity from the verified Token. */
  readonly identityId: string;
  /** Deployment binding from the verified Token. */
  readonly deploymentId: string;
  /** Authority-allocated connection generation. */
  readonly connectionGeneration: number;
  /** Process-local role assigned to this physical connection. */
  readonly role: 'authoritative' | 'candidate';
  /** Whether this generation may carry control, readiness, or route work. */
  readonly mayCarryWork: boolean;
}

/** Failed production admission result. */
export interface AdmitNanoHostTransportConnectionFailure {
  /** Admission failed. */
  readonly ok: false;
  /** Stable machine-readable failure reason (no secret material). */
  readonly reason:
    | 'missing_connection_context'
    | 'unauthorized'
    | 'rejected'
    | 'storage_unavailable'
    | 'nanohost_protocol_mismatch';
}

/** Result of admitting one NanoHost transport connection generation. */
export type AdmitNanoHostTransportConnectionResult =
  | AdmitNanoHostTransportConnectionSuccess
  | AdmitNanoHostTransportConnectionFailure;

type TransportAdmissionStorage = {
  verify(
    secret: string,
    options: NonNullable<Parameters<typeof verifyNanoHostTransportTokenRecord>[2]>
  ): Promise<NanoHostTransportTokenRecord | null>;
  readCurrent(
    tokenId: string,
    now?: Date
  ): NanoHostTransportTokenRecord | null | Promise<NanoHostTransportTokenRecord | null>;
  allocate(
    input: AllocateNanoHostRuntimeTargetConnectionGenerationInput
  ): Promise<NanoHostRuntimeTargetRecord>;
  close(input: RecordNanoHostRuntimeTargetConnectionCloseInput): Promise<unknown>;
  stillOpen?(): boolean;
};

class NanoHostTransportStorageUnavailable extends Error {}

function requireNativeResult<Value>(
  result: StorageResult<'nanohost' | 'control-kernel', Value>
): Value {
  if (result.state !== 'ready') throw new NanoHostTransportStorageUnavailable();
  return result.value;
}

function readCurrentTransportToken(
  owner: { readonly sqlite: Database.Database },
  tokenId: string,
  now?: Date
): NanoHostTransportTokenRecord | null {
  const token = getNanoHostTransportTokenRecord(owner, tokenId);
  return token &&
    isNanoHostTransportIdentityActive(owner, token.ownerNanoHostIdentityId, token.deploymentId) &&
    evaluateNanoHostTransportTokenUsability(token, now).usable
    ? token
    : null;
}

/** Admits transport only through the admitted native owner and the exact original epoch decision. */
export async function admitNativeNanoHostTransportConnection(
  storage: AdmittedNanoHostTransportStorage,
  authority: NanoHostTransportSessionAuthority,
  input: AdmitNanoHostTransportConnectionInput
): Promise<AdmitNanoHostTransportConnectionResult> {
  const { owner } = storage;
  const transition = async (
    target: Parameters<typeof transitionAdmittedNanoHostRuntimeTarget>[1]
  ) => requireNativeResult(await transitionAdmittedNanoHostRuntimeTarget(storage, target));
  try {
    return await admitTransportConnection(
      {
        async verify(secret, options) {
          return afterAdmittedNanoHostAcknowledgement(
            storage,
            async () => {
              const request = requireNativeResult(
                owner.read((sqlite) =>
                  prepareNanoHostTransportVerification({ sqlite }, secret, options)
                )
              );
              if (!request) return null;
              const result = await owner.transport(request);
              if (result.kind !== 'record') throw new NanoHostTransportStorageUnavailable();
              return result.record;
            },
            input.signal
          );
        },
        readCurrent: (tokenId, now) =>
          afterAdmittedNanoHostAcknowledgement(
            storage,
            () =>
              requireNativeResult(
                owner.read((sqlite) => readCurrentTransportToken({ sqlite }, tokenId, now))
              ),
            input.signal
          ),
        async allocate(target) {
          const record = await transition({ ...target, kind: 'allocate' });
          if (!record) throw new NanoHostTransportStorageUnavailable();
          return record;
        },
        close: (target) => transition({ ...target, kind: 'close' }),
      },
      authority,
      input
    );
  } catch {
    // A missing read, refused epoch or unknown owner commit cannot admit the physical connection.
    return { ok: false, reason: 'storage_unavailable' };
  }
}

/**
 * Admits one NanoHost transport connection after hash-only Token verification.
 *
 * Production admission path for NanoHost→NanoCore session establishment: verifies
 * the presented `nanohost-transport` secret and exact compiled revision before durable allocation, allocates
 * generation one or high-water plus one, then binds it to the exact native
 * physical connection. Successors remain non-authoritative until server-observed
 * predecessor close fencing promotes them.
 *
 * @param coreDb Open Core database handles.
 * @param authority Process-local NanoHost transport session authority.
 * @param input Presented secret, native connection context, and RuntimeTarget id.
 * @returns Verified bound admission or a fail-closed result.
 */
export async function admitNanoHostTransportConnection(
  coreDb: CoreDb,
  authority: NanoHostTransportSessionAuthority,
  input: AdmitNanoHostTransportConnectionInput
): Promise<AdmitNanoHostTransportConnectionResult> {
  return await admitTransportConnection(
    {
      verify: (secret, options) => verifyNanoHostTransportTokenRecord(coreDb, secret, options),
      readCurrent: (tokenId, now) => readCurrentTransportToken(coreDb, tokenId, now),
      allocate: (target) => allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, target),
      close: (target) => recordNanoHostRuntimeTargetConnectionClose(coreDb, target),
      stillOpen: () => coreDb.sqlite.open,
    },
    authority,
    input
  );
}

async function admitTransportConnection(
  storage: TransportAdmissionStorage,
  authority: NanoHostTransportSessionAuthority,
  input: AdmitNanoHostTransportConnectionInput
): Promise<AdmitNanoHostTransportConnectionResult> {
  const request = { ...input, ...(input.now ? { now: new Date(input.now.getTime()) } : {}) };
  const verified = await storage.verify(request.secret, {
    channel: request.channel ?? 'nanohost-transport',
    source: request.source ?? 'session-admit',
    ...(request.now ? { now: request.now } : {}),
  });

  const current = verified ? await storage.readCurrent(verified.tokenId, request.now) : null;
  if (
    !verified ||
    !current ||
    current.ownerNanoHostIdentityId !== verified.ownerNanoHostIdentityId ||
    current.deploymentId !== verified.deploymentId
  ) {
    return { ok: false, reason: 'unauthorized' };
  }

  const physicalConnection = request.physicalConnection;
  if (!physicalConnection || !isNanoHostPhysicalConnectionContext(physicalConnection)) {
    return { ok: false, reason: 'missing_connection_context' };
  }
  const connection = physicalConnection as Http2Session;
  if (
    connection.destroyed ||
    connection.closed ||
    authority.connectionGeneration(physicalConnection) !== null
  ) {
    return { ok: false, reason: 'rejected' };
  }

  if (request.transportRevision !== String(transportRevision)) {
    return { ok: false, reason: 'nanohost_protocol_mismatch' };
  }

  if (!consumeNanoHostPhysicalConnectionAdmission(physicalConnection)) {
    return { ok: false, reason: 'rejected' };
  }

  // Allocation and its closed-physical continuation are one accepted producer lifetime.
  return getControlStoreWorkerClient().runOperation(async () => {
    const targetId = request.targetId?.trim() || verified.ownerNanoHostIdentityId;
    const observedAt = (request.now ?? new Date()).toISOString();
    const target = await storage.allocate({
      deploymentId: verified.deploymentId,
      identityId: verified.ownerNanoHostIdentityId,
      observedAt,
      targetId,
    });
    const closeAllocated = () =>
      storage.close({
        authoritativeGeneration: authority.authoritativeGeneration(
          verified.ownerNanoHostIdentityId
        ),
        closedGeneration: target.connectionGeneration,
        observedAt,
        targetId,
      });
    let admittedToken: NanoHostTransportTokenRecord | null;
    try {
      const current = storage.readCurrent(verified.tokenId, request.now);
      admittedToken = current instanceof Promise ? await current : current;
    } catch (error) {
      await closeAllocated();
      throw error;
    }
    if (
      connection.destroyed ||
      connection.closed ||
      !admittedToken ||
      admittedToken.ownerNanoHostIdentityId !== verified.ownerNanoHostIdentityId ||
      admittedToken.deploymentId !== verified.deploymentId
    ) {
      await closeAllocated();
      return { ok: false, reason: 'rejected' };
    }
    const session = authority.admit({
      connectionGeneration: target.connectionGeneration,
      identityId: verified.ownerNanoHostIdentityId,
      physicalConnection: physicalConnection,
      onClose: async (closed) => {
        if (storage.stillOpen?.() === false || closed.closedGeneration === null) {
          return;
        }
        await storage.close({
          authoritativeGeneration: closed.authoritativeGeneration,
          closedGeneration: closed.closedGeneration,
          observedAt: new Date().toISOString(),
          targetId,
        });
      },
    });

    if (session.role !== 'authoritative' && session.role !== 'candidate') {
      await closeAllocated();
      return { ok: false, reason: 'rejected' };
    }

    return {
      ok: true,
      tokenId: verified.tokenId,
      identityId: verified.ownerNanoHostIdentityId,
      deploymentId: verified.deploymentId,
      connectionGeneration: session.connectionGeneration,
      role: session.role,
      mayCarryWork: authority.mayCarryWork(physicalConnection),
    };
  });
}

/**
 * Registers the NanoHost transport session admission HTTP route.
 *
 * These routes are the production NanoHost→NanoCore admission path. They verify
 * the presented `nanohost-transport` Token themselves and are not product App API
 * actor paths.
 *
 * @param dependencies Route dependencies owned by the app composition root.
 */
export function registerNanoHostTransportAdmissionRoutes({
  app,
  coreDb,
  nativeStorage,
  nanoHostConfig,
  sessionAuthority,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly nativeStorage?: StorageResult<'nanohost', AdmittedNanoHostTransportStorage>;
  readonly nanoHostConfig?: OpenKitNanoHostConfig;
  readonly sessionAuthority: NanoHostTransportSessionAuthority;
}): void {
  app.post('/api/nanohost/transport/session/admit', async (c) => {
    if (nativeStorage ? nativeStorage.state !== 'ready' : !coreDb) return unavailableAdmission();

    const secret = readBearerSecret(c);
    if (!secret) {
      return asApiError(
        'NanoHost transport Token required.',
        'nanohost_transport_admission_unauthorized',
        401
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return asInvalidRequestError(
        new Error('Invalid JSON body.'),
        'nanohost_transport_admission_invalid_request'
      );
    }

    const parsed = parseAdmitBody(body);
    if (!parsed.ok) {
      return asInvalidRequestError(
        new Error(parsed.message),
        'nanohost_transport_admission_invalid_request'
      );
    }

    const physicalConnection = readNanoHostPhysicalConnectionContext(
      (c.env as { readonly incoming?: unknown } | undefined)?.incoming
    );
    const input = {
      channel: 'nanohost-transport',
      physicalConnection,
      transportRevision: c.req.header('x-openkit-nanohost-transport-revision'),
      secret,
      source: 'session-admit-http',
      signal: c.req.raw.signal,
      ...(nanoHostConfig?.identityId ? { targetId: nanoHostConfig.identityId } : {}),
    };
    const admitted =
      nativeStorage?.state === 'ready'
        ? await admitNativeNanoHostTransportConnection(nativeStorage.value, sessionAuthority, input)
        : await admitNanoHostTransportConnection(coreDb!, sessionAuthority, input);

    if (!admitted.ok) {
      if (admitted.reason === 'storage_unavailable') return unavailableAdmission();
      if (admitted.reason === 'nanohost_protocol_mismatch') {
        return asApiError(
          'NanoHost transport revision does not match NanoCore.',
          'nanohost_protocol_mismatch',
          409
        );
      }
      const status = admitted.reason === 'unauthorized' ? 401 : 409;
      return asApiError(
        admitted.reason === 'unauthorized'
          ? 'NanoHost transport Token required.'
          : admitted.reason === 'missing_connection_context'
            ? 'NanoHost transport native connection context required.'
            : 'NanoHost transport physical connection was rejected.',
        admitted.reason === 'unauthorized'
          ? 'nanohost_transport_admission_unauthorized'
          : admitted.reason === 'missing_connection_context'
            ? 'nanohost_transport_admission_missing_connection_context'
            : 'nanohost_transport_admission_rejected',
        status
      );
    }

    c.header('x-openkit-nanohost-transport-revision', String(transportRevision));
    return c.json({
      tokenId: admitted.tokenId,
      identityId: admitted.identityId,
      deploymentId: admitted.deploymentId,
      connectionGeneration: admitted.connectionGeneration,
      role: admitted.role,
      mayCarryWork: admitted.mayCarryWork,
    });
  });
}

/**
 * Returns whether a path is a NanoHost transport admission route.
 *
 * @param path Request pathname.
 * @returns True only for the native admission path.
 */
export function isNanoHostTransportAdmissionPath(path: string): boolean {
  return path === '/api/nanohost/transport/session/admit';
}

function unavailableAdmission(): Response {
  return asApiError(
    'NanoHost transport token storage is unavailable.',
    'nanohost_transport_storage_unavailable',
    503
  );
}

/**
 * Reads the bearer secret from an admission request.
 *
 * @param c Hono context.
 * @returns Bearer secret or null.
 */
function readBearerSecret(c: Context<{ Variables: AuthVariables }>): string | null {
  const authorization = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
}

/**
 * Parses an admit request body.
 *
 * @param body Unknown JSON body.
 * @returns Parsed fields or an error message.
 */
function parseAdmitBody(body: unknown): { ok: true } | { ok: false; message: string } {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? { ok: true }
    : { ok: false, message: 'Admit body must be an object.' };
}
