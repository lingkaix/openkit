import { ApiCallError, type CoreClient, createCoreClient } from '@openkit/core-client';
import { useQuery } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  type ConnectionPosture,
  isBusyStatus,
  readRetryAfterSeconds,
} from '../screens/chat/timeline/degraded';

/**
 * Core-client wiring (rebuild-stack data boundary). The Web UI consumes the
 * server ONLY through the composed `@openkit/core-client` sub-clients, and all
 * reads/mutations flow through TanStack Query — server state is never duplicated
 * into Zustand.
 */

const CoreClientContext = createContext<CoreClient | null>(null);

/** Why a live transport stopped, and the exact retry action that owns it. */
export type ConnectionFailureKind = 'reconnecting' | 'busy' | 'out-of-date';

/** One live transport failure and the exact retry action that owns it. */
interface ConnectionFailure {
  owner: object;
  retry: () => void;
  kind: ConnectionFailureKind;
  retryAfterSeconds: number | null;
}

/** Shared operations for reporting and clearing the current live transport failure. */
interface ConnectionFailureContextValue {
  failure: ConnectionFailure | null;
  report: (
    owner: object,
    retry: () => void,
    kind?: ConnectionFailureKind,
    retryAfterSeconds?: number | null
  ) => void;
  clear: (owner: object) => void;
}

const ConnectionFailureContext = createContext<ConnectionFailureContextValue | null>(null);

let defaultClient: CoreClient | null = null;

/** The process-wide client, created against the dev-proxied `/api` origin. */
export function getDefaultCoreClient(): CoreClient {
  if (!defaultClient) {
    defaultClient = createCoreClient({
      baseUrl: import.meta.env.VITE_CORE_BASE_URL ?? '',
    });
  }
  return defaultClient;
}

/**
 * Provides the composed Core client and app-wide transport failure posture.
 *
 * @param client Composed client used by all descendant data hooks.
 * @param children React descendants that consume the client.
 * @returns The client and connection-failure providers.
 */
export function CoreClientProvider({
  client,
  children,
}: {
  client: CoreClient;
  children: ReactNode;
}) {
  const [failure, setFailure] = useState<ConnectionFailure | null>(null);
  const report = useCallback(
    (
      owner: object,
      retry: () => void,
      kind: ConnectionFailureKind = 'reconnecting',
      retryAfterSeconds: number | null = null
    ) => {
      setFailure({ owner, retry, kind, retryAfterSeconds });
    },
    []
  );
  const clear = useCallback((owner: object) => {
    setFailure((current) => (current?.owner === owner ? null : current));
  }, []);
  const connectionFailure = useMemo(() => ({ failure, report, clear }), [clear, failure, report]);

  return (
    <CoreClientContext.Provider value={client}>
      <ConnectionFailureContext.Provider value={connectionFailure}>
        {children}
      </ConnectionFailureContext.Provider>
    </CoreClientContext.Provider>
  );
}

/** Access the CoreClient; throws if used outside the provider. */
export function useCoreClient(): CoreClient {
  const client = useContext(CoreClientContext);
  if (!client) throw new Error('useCoreClient must be used within CoreClientProvider');
  return client;
}

/** The mounted client, or null where a timeline fold is rendered outside the provider. */
export function useOptionalCoreClient(): CoreClient | null {
  return useContext(CoreClientContext);
}

/**
 * Accesses the shared transport-failure channel used by bounded live streams.
 *
 * @returns The current failure plus owner-scoped report and clear operations.
 * @throws Error when called outside CoreClientProvider.
 */
export function useConnectionFailure(): ConnectionFailureContextValue {
  const failure = useContext(ConnectionFailureContext);
  if (!failure) throw new Error('useConnectionFailure must be used within CoreClientProvider');
  return failure;
}

export interface Connection {
  /** The runtime is reachable enough that actions still work. Reconnecting counts. */
  connected: boolean;
  /** The first probe is still in flight. */
  checking: boolean;
  /** Sending and state-changing actions are paused. */
  failed: boolean;
  /** Which banner, if any, the shell should show. */
  posture: ConnectionPosture;
  /** Epoch milliseconds of the last successful probe, when this mount has one. */
  lastLoadedAt: number | null;
  /** Countdown for a busy runtime. Null for every other posture. */
  retryAfterSeconds: number | null;
  /** Retry the probe now. */
  retry: () => void;
}

function subscribeBrowserOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** Follows the browser's online state, so going offline re-renders without another update. */
function useBrowserOnline(): boolean {
  return useSyncExternalStore(
    subscribeBrowserOnline,
    () => navigator.onLine,
    () => true
  );
}

/**
 * Global connection state, derived from a lightweight `core.meta()` probe. The
 * whole app is a visible follower over NanoCore, so a disconnected state must be
 * globally legible (DESIGN.md §9.12); per-surface content degrades rather than
 * blanking out.
 */
export function useConnection(): Connection {
  const client = useCoreClient();
  const stream = useConnectionFailure();
  const online = useBrowserOnline();
  const loadedAt = useRef<number | null>(null);
  const query = useQuery({
    queryKey: ['core', 'meta'],
    queryFn: () => client.core.meta(),
    retry: 1,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
  if (query.isSuccess && query.dataUpdatedAt > 0) loadedAt.current = query.dataUpdatedAt;
  const probeBusy = isBusyStatus(query.error);
  const streamKind = stream.failure?.kind;
  const checking = query.isLoading;
  let posture: ConnectionPosture = 'connected';
  if (!online) posture = 'offline';
  else if (streamKind === 'out-of-date') posture = 'out-of-date';
  else if (probeBusy || streamKind === 'busy') posture = 'busy';
  else if (query.isError) posture = 'unreachable';
  else if (streamKind === 'reconnecting') posture = 'reconnecting';
  else if (checking) posture = 'checking';
  const queryStatus = query.error instanceof ApiCallError ? query.error.status : null;
  const retryAfterSeconds =
    posture === 'busy'
      ? (stream.failure?.retryAfterSeconds ??
        (queryStatus === 429 || queryStatus === 503 ? readRetryAfterSeconds(query.error) : 20))
      : null;
  const actionsPaused =
    posture === 'offline' ||
    posture === 'busy' ||
    posture === 'out-of-date' ||
    posture === 'unreachable';
  return {
    connected: !actionsPaused && posture !== 'checking',
    checking,
    failed: actionsPaused,
    posture,
    lastLoadedAt: loadedAt.current,
    retryAfterSeconds,
    retry: () => {
      void query.refetch();
      stream.failure?.retry();
    },
  };
}
