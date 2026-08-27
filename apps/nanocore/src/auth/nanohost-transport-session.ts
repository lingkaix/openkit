/**
 * NanoHost transport session authority and predecessor fencing.
 *
 * Owns process-local connection-generation admission for one configured
 * NanoHost identity: at most one authoritative generation, successor work
 * blocked until the predecessor is fenced, and late predecessor rejection
 * after fencing. Also exposes the non-loopback bind TLS requirement policy
 * consumed by the real listener owner in `index.ts` (Unit 2).
 */

import { Http2ServerRequest } from 'node:http2';

import type { OpenKitNanoHostConfig } from '@openkit/config-schema';

import { isLoopbackHost } from './middleware.js';

/** Role of one connection generation for a NanoHost identity. */
export type NanoHostTransportSessionRole = 'authoritative' | 'candidate' | 'fenced' | 'rejected';

/** One admitted NanoHost physical connection result. */
export interface NanoHostTransportSessionAdmission {
  /** Configured NanoHost identity id. */
  readonly identityId: string;
  /** Authority-allocated connection generation. */
  readonly connectionGeneration: number;
  /** Current authority role for this generation. */
  readonly role: NanoHostTransportSessionRole;
}

/** Result of closing one bound physical connection. */
export interface NanoHostTransportPhysicalConnectionCloseResult {
  /** Configured NanoHost identity id, or null for an unknown connection. */
  readonly identityId: string | null;
  /** Closed generation, or null for an unknown connection. */
  readonly closedGeneration: number | null;
  /** Promoted successor generation, when one exists. */
  readonly authoritativeGeneration: number | null;
}

/** Resolved dedicated NanoHost native HTTP/2 listener. */
export interface NanoHostTransportListener {
  /** Local hostname passed to the native listener. */
  readonly hostname: string;
  /** Local TCP port passed to the native listener. */
  readonly port: number;
  /** Whether the listener requires server-authenticated TLS. */
  readonly secure: boolean;
}

/** Input for binding one authority-allocated generation to a physical connection. */
export interface AdmitNanoHostTransportSessionInput {
  /** Configured NanoHost identity id. */
  readonly identityId: string;
  /** Authority-allocated durable connection generation. */
  readonly connectionGeneration: number;
  /** Opaque native HTTP/2 physical connection identity. */
  readonly physicalConnection: object;
  /** Persists the exact close result after process-local fencing. */
  readonly onClose?: (result: NanoHostTransportPhysicalConnectionCloseResult) => void;
}

/**
 * Process-local NanoHost transport session authority store.
 */
export interface NanoHostTransportSessionAuthority {
  /**
   * Binds an allocated generation to one native physical connection.
   *
   * @param input Allocated identity, generation, and native connection.
   * @returns Admission describing the bound role for that generation.
   */
  admit(input: AdmitNanoHostTransportSessionInput): NanoHostTransportSessionAdmission;

  /**
   * Closes and fences one exact bound physical connection.
   *
   * @param physicalConnection Native connection identity observed closed by the server.
   * @returns Closed and promoted generation facts.
   */
  closePhysicalConnection(
    physicalConnection: object
  ): NanoHostTransportPhysicalConnectionCloseResult;

  /**
   * Reads the generation already bound to one physical connection.
   *
   * @param physicalConnection Physical connection identity to inspect.
   * @returns Bound generation, or null when the connection is unknown.
   */
  connectionGeneration(physicalConnection: object): number | null;

  /**
   * Records that the predecessor generation is fenced for one identity.
   *
   * @param identityId Configured NanoHost identity id.
   * @param predecessorGeneration Generation that must no longer carry work.
   */
  fencePredecessor(identityId: string, predecessorGeneration: number): void;

  /**
   * Returns whether the exact physical connection may carry work.
   *
   * @param physicalConnection Physical connection identity to evaluate.
   * @returns True only for the current authoritative generation.
   */
  mayCarryWork(physicalConnection: object): boolean;

  /**
   * Returns the sole authoritative connection generation for an identity.
   *
   * @param identityId Configured NanoHost identity id.
   * @returns Authoritative generation, or null when none is authoritative.
   */
  authoritativeGeneration(identityId: string): number | null;

  /**
   * Fences the current authoritative generation without promoting a successor.
   *
   * Used by revocation, expiry, and decommission so live authoritative work is
   * denied immediately. Pending candidates are discarded.
   *
   * @param identityId Configured NanoHost identity id.
   */
  fenceAuthoritative(identityId: string): void;

  /**
   * Discards a pending non-authoritative successor candidate without fencing
   * the current authoritative generation.
   *
   * Used by rotation abort after the successor Token and slot are cleared.
   *
   * @param identityId Configured NanoHost identity id.
   */
  discardPendingSuccessor(identityId: string): void;
}

/** Mutable record for one identity and connection generation. */
interface SessionRecord {
  readonly identityId: string;
  readonly connectionGeneration: number;
  readonly predecessorGeneration: number | null;
  readonly physicalConnection: object;
  role: NanoHostTransportSessionRole;
}

/** Native HTTP/2 sessions created by the Node server accept path. */
const nativePhysicalConnections = new WeakSet<object>();

/**
 * Reads and brands the opaque physical connection from a native H2 request context.
 *
 * Synthetic Fetch requests and non-H2 incoming requests have no admissible
 * connection identity. The returned Node session object is process-local and
 * cannot be serialized or supplied by request content.
 *
 * @param incoming Native request supplied by the Hono Node adapter.
 * @returns Opaque accepted H2 session identity, or null when context is absent.
 */
export function readNanoHostPhysicalConnectionContext(incoming: unknown): object | null {
  if (!(incoming instanceof Http2ServerRequest)) {
    return null;
  }
  const session = incoming.stream.session;
  if (!session || session.destroyed) {
    return null;
  }
  nativePhysicalConnections.add(session);
  return session;
}

/**
 * Returns whether a value came from the native HTTP/2 accept context.
 *
 * @param physicalConnection Candidate physical connection value.
 * @returns True only for a server-created, process-local H2 session identity.
 */
export function isNanoHostPhysicalConnectionContext(physicalConnection: object): boolean {
  return nativePhysicalConnections.has(physicalConnection);
}

/**
 * Creates the NanoHost transport session authority store.
 *
 * Enforces exactly one authoritative connection generation per configured
 * NanoHost identity. A successor is admitted as a non-authoritative candidate
 * and may carry work only after `fencePredecessor` proves the predecessor is
 * fenced.
 *
 * @returns Session authority store.
 */
export function createNanoHostTransportSessionAuthority(): NanoHostTransportSessionAuthority {
  const sessions = new Map<string, SessionRecord>();
  const sessionsByConnection = new WeakMap<object, SessionRecord>();
  const authoritativeByIdentity = new Map<string, number>();
  const pendingSuccessorByIdentity = new Map<string, number>();

  /** Fences a predecessor and promotes only its exact pending successor. */
  const fenceAndPromote = (identityId: string, predecessorGeneration: number): number | null => {
    const predecessor = sessions.get(sessionKey(identityId, predecessorGeneration));
    if (predecessor === undefined) {
      return authoritativeByIdentity.get(identityId) ?? null;
    }
    predecessor.role = 'fenced';
    if (authoritativeByIdentity.get(identityId) === predecessorGeneration) {
      authoritativeByIdentity.delete(identityId);
    }
    const successorGeneration = pendingSuccessorByIdentity.get(identityId);
    if (successorGeneration === undefined) {
      return authoritativeByIdentity.get(identityId) ?? null;
    }
    const successor = sessions.get(sessionKey(identityId, successorGeneration));
    if (
      successor === undefined ||
      successor.role !== 'candidate' ||
      successor.predecessorGeneration !== predecessorGeneration
    ) {
      return authoritativeByIdentity.get(identityId) ?? null;
    }
    successor.role = 'authoritative';
    authoritativeByIdentity.set(identityId, successorGeneration);
    pendingSuccessorByIdentity.delete(identityId);
    return successorGeneration;
  };

  /** Closes one exact connection and applies predecessor promotion. */
  const closePhysicalConnection = (
    physicalConnection: object
  ): NanoHostTransportPhysicalConnectionCloseResult => {
    const record = sessionsByConnection.get(physicalConnection);
    if (!record) {
      return { authoritativeGeneration: null, closedGeneration: null, identityId: null };
    }
    if (record.role === 'fenced' || record.role === 'rejected') {
      return {
        authoritativeGeneration: authoritativeByIdentity.get(record.identityId) ?? null,
        closedGeneration: record.connectionGeneration,
        identityId: record.identityId,
      };
    }
    if (record.role === 'candidate') {
      record.role = 'fenced';
      if (pendingSuccessorByIdentity.get(record.identityId) === record.connectionGeneration) {
        pendingSuccessorByIdentity.delete(record.identityId);
      }
      return {
        authoritativeGeneration: authoritativeByIdentity.get(record.identityId) ?? null,
        closedGeneration: record.connectionGeneration,
        identityId: record.identityId,
      };
    }
    const authoritativeGeneration = fenceAndPromote(record.identityId, record.connectionGeneration);
    return {
      authoritativeGeneration,
      closedGeneration: record.connectionGeneration,
      identityId: record.identityId,
    };
  };

  return {
    admit(input) {
      const authoritative = authoritativeByIdentity.get(input.identityId);
      const predecessorGeneration = authoritative ?? null;
      const rejected = (): NanoHostTransportSessionAdmission => ({
        connectionGeneration: input.connectionGeneration,
        identityId: input.identityId,
        role: 'rejected',
      });
      if (
        !nativePhysicalConnections.has(input.physicalConnection) ||
        sessionsByConnection.has(input.physicalConnection) ||
        !Number.isSafeInteger(input.connectionGeneration) ||
        input.connectionGeneration < 1
      ) {
        return rejected();
      }
      const key = sessionKey(input.identityId, input.connectionGeneration);
      const sameOrNewerGenerationWasSeen = [...sessions.values()].some(
        (session) =>
          session.identityId === input.identityId &&
          session.connectionGeneration >= input.connectionGeneration
      );
      if (sameOrNewerGenerationWasSeen || sessions.has(key)) {
        return rejected();
      }
      if (authoritative !== undefined && input.connectionGeneration <= authoritative) {
        return rejected();
      }
      const pending = pendingSuccessorByIdentity.get(input.identityId);
      if (pending !== undefined) {
        return rejected();
      }
      const record = storeSession(sessions, key, {
        identityId: input.identityId,
        connectionGeneration: input.connectionGeneration,
        physicalConnection: input.physicalConnection,
        predecessorGeneration,
        role: authoritative === undefined ? 'authoritative' : 'candidate',
      });
      sessionsByConnection.set(input.physicalConnection, record);
      if (record.role === 'authoritative') {
        authoritativeByIdentity.set(input.identityId, input.connectionGeneration);
      } else {
        pendingSuccessorByIdentity.set(input.identityId, input.connectionGeneration);
      }
      const connection = input.physicalConnection as {
        once(event: 'close', listener: () => void): unknown;
      };
      connection.once('close', () => {
        const result = closePhysicalConnection(input.physicalConnection);
        input.onClose?.(result);
      });
      return toAdmission(record);
    },

    closePhysicalConnection,

    connectionGeneration(physicalConnection) {
      return sessionsByConnection.get(physicalConnection)?.connectionGeneration ?? null;
    },

    fencePredecessor(identityId, predecessorGeneration) {
      fenceAndPromote(identityId, predecessorGeneration);
    },

    fenceAuthoritative(identityId) {
      const authoritative = authoritativeByIdentity.get(identityId);
      if (authoritative === undefined) {
        pendingSuccessorByIdentity.delete(identityId);
        return;
      }

      const record = sessions.get(sessionKey(identityId, authoritative));
      if (record !== undefined) {
        record.role = 'fenced';
      }
      authoritativeByIdentity.delete(identityId);
      pendingSuccessorByIdentity.delete(identityId);
    },

    discardPendingSuccessor(identityId) {
      const pending = pendingSuccessorByIdentity.get(identityId);
      if (pending === undefined) {
        return;
      }
      const record = sessions.get(sessionKey(identityId, pending));
      if (record !== undefined && record.role === 'candidate') {
        record.role = 'rejected';
      }
      pendingSuccessorByIdentity.delete(identityId);
    },

    mayCarryWork(physicalConnection) {
      const record = sessionsByConnection.get(physicalConnection);
      return Boolean(
        record &&
          record.role === 'authoritative' &&
          authoritativeByIdentity.get(record.identityId) === record.connectionGeneration
      );
    },

    authoritativeGeneration(identityId) {
      return authoritativeByIdentity.get(identityId) ?? null;
    },
  };
}

/**
 * Returns whether a NanoCore bind host requires server-authenticated TLS for
 * the NanoHost transport boundary.
 *
 * Non-loopback binds require server-authenticated TLS. Exact same-host
 * loopback is the only plaintext exception. Listener application of this
 * policy belongs to `index.ts` (Unit 2).
 *
 * @param bindHost Resolved NanoCore bind host.
 * @returns True when server-authenticated TLS is required.
 */
export function bindRequiresServerAuthenticatedTls(bindHost: string): boolean {
  return !isLoopbackHost(bindHost);
}

/**
 * Resolves the dedicated native HTTP/2 listener from authored NanoHost config.
 *
 * Plaintext is admitted only when both the local bind and advertised
 * rendezvous are loopback. The App listener has no fallback authority.
 *
 * @param config Optional configured NanoHost deployment.
 * @param appPort Resolved App listener port.
 * @returns Dedicated listener or null when NanoHost is not configured.
 * @throws Error when plaintext would cross a non-loopback boundary.
 */
export function resolveNanoHostTransportListener(
  config: OpenKitNanoHostConfig | undefined,
  appPort: number
): NanoHostTransportListener | null {
  if (!config) {
    return null;
  }
  if (config.bind.port === appPort) {
    throw new Error('App and NanoHost listeners must use distinct TCP ports.');
  }

  const rendezvous = new URL(config.rendezvousUrl);
  const hostname = config.bind.host.replace(/^\[(.*)\]$/u, '$1');
  const secure = rendezvous.protocol === 'https:';
  if (!secure && (!isLoopbackHost(hostname) || !isLoopbackHost(rendezvous.hostname))) {
    throw new Error('Plaintext NanoHost HTTP/2 requires loopback listener and rendezvous hosts.');
  }

  return { hostname, port: config.bind.port, secure };
}

/**
 * Builds the map key for one identity and connection generation.
 *
 * @param identityId NanoHost identity id.
 * @param connectionGeneration Connection generation.
 * @returns Stable map key.
 */
function sessionKey(identityId: string, connectionGeneration: number): string {
  return `${identityId}:${connectionGeneration}`;
}

/**
 * Stores one session record and returns it.
 *
 * @param sessions Session map.
 * @param key Map key.
 * @param record Session record to store.
 * @returns Stored record.
 */
function storeSession(
  sessions: Map<string, SessionRecord>,
  key: string,
  record: SessionRecord
): SessionRecord {
  sessions.set(key, record);
  return record;
}

/**
 * Projects a mutable session record to an immutable admission result.
 *
 * @param record Session record.
 * @returns Admission snapshot for the caller.
 */
function toAdmission(record: SessionRecord): NanoHostTransportSessionAdmission {
  return {
    identityId: record.identityId,
    connectionGeneration: record.connectionGeneration,
    role: record.role,
  };
}
