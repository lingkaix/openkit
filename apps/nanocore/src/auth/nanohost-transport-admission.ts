import type { Http2Session } from 'node:http2';
import type { OpenKitNanoHostConfig } from '@openkit/config-schema';
import type { Context, Hono } from 'hono';
import { asApiError, asInvalidRequestError } from '../api-errors.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  recordNanoHostRuntimeTargetConnectionClose,
} from '../runtime/nanohost-runtime-target.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
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
    | 'nanohost_protocol_mismatch';
}

/** Result of admitting one NanoHost transport connection generation. */
export type AdmitNanoHostTransportConnectionResult =
  | AdmitNanoHostTransportConnectionSuccess
  | AdmitNanoHostTransportConnectionFailure;

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
  const request = { ...input, ...(input.now ? { now: new Date(input.now.getTime()) } : {}) };
  const verified = await verifyNanoHostTransportTokenRecord(coreDb, request.secret, {
    channel: request.channel ?? 'nanohost-transport',
    source: request.source ?? 'session-admit',
    ...(request.now ? { now: request.now } : {}),
  });

  const current = verified ? getNanoHostTransportTokenRecord(coreDb, verified.tokenId) : null;
  if (
    !verified ||
    !current ||
    current.ownerNanoHostIdentityId !== verified.ownerNanoHostIdentityId ||
    current.deploymentId !== verified.deploymentId ||
    !isNanoHostTransportIdentityActive(
      coreDb,
      current.ownerNanoHostIdentityId,
      current.deploymentId
    ) ||
    !evaluateNanoHostTransportTokenUsability(current, request.now).usable
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
    const target = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: verified.deploymentId,
      identityId: verified.ownerNanoHostIdentityId,
      observedAt,
      targetId,
    });
    const admittedToken = getNanoHostTransportTokenRecord(coreDb, verified.tokenId);
    if (
      connection.destroyed ||
      connection.closed ||
      !admittedToken ||
      !evaluateNanoHostTransportTokenUsability(admittedToken, request.now).usable ||
      !isNanoHostTransportIdentityActive(
        coreDb,
        verified.ownerNanoHostIdentityId,
        verified.deploymentId
      )
    ) {
      await recordNanoHostRuntimeTargetConnectionClose(coreDb, {
        authoritativeGeneration: authority.authoritativeGeneration(
          verified.ownerNanoHostIdentityId
        ),
        closedGeneration: target.connectionGeneration,
        observedAt,
        targetId,
      });
      return { ok: false, reason: 'rejected' };
    }
    const session = authority.admit({
      connectionGeneration: target.connectionGeneration,
      identityId: verified.ownerNanoHostIdentityId,
      physicalConnection: physicalConnection,
      onClose: async (closed) => {
        if (!coreDb.sqlite.open) {
          return;
        }
        if (closed.closedGeneration === null) {
          return;
        }
        await recordNanoHostRuntimeTargetConnectionClose(coreDb, {
          authoritativeGeneration: closed.authoritativeGeneration,
          closedGeneration: closed.closedGeneration,
          observedAt: new Date().toISOString(),
          targetId,
        });
      },
    });

    if (session.role !== 'authoritative' && session.role !== 'candidate') {
      await recordNanoHostRuntimeTargetConnectionClose(coreDb, {
        authoritativeGeneration: authority.authoritativeGeneration(
          verified.ownerNanoHostIdentityId
        ),
        closedGeneration: target.connectionGeneration,
        observedAt,
        targetId,
      });
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
  nanoHostConfig,
  sessionAuthority,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly nanoHostConfig?: OpenKitNanoHostConfig;
  readonly sessionAuthority: NanoHostTransportSessionAuthority;
}): void {
  app.post('/api/nanohost/transport/session/admit', async (c) => {
    const storageError = requireAdmissionStorage(c, coreDb);
    if (storageError) {
      return storageError;
    }

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
    const admitted = await admitNanoHostTransportConnection(coreDb!, sessionAuthority, {
      channel: 'nanohost-transport',
      physicalConnection,
      transportRevision: c.req.header('x-openkit-nanohost-transport-revision'),
      secret,
      source: 'session-admit-http',
      ...(nanoHostConfig?.identityId ? { targetId: nanoHostConfig.identityId } : {}),
    });

    if (!admitted.ok) {
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

/**
 * Requires Core storage for NanoHost transport admission.
 *
 * @param _c Unused Hono context.
 * @param coreDb Optional Core database.
 * @returns Error response when storage is unavailable.
 */
function requireAdmissionStorage(
  _c: Context<{ Variables: AuthVariables }>,
  coreDb: CoreDb | undefined
): Response | null {
  if (!coreDb) {
    return asApiError(
      'NanoHost transport token storage is unavailable.',
      'nanohost_transport_storage_unavailable',
      503
    );
  }
  return null;
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
