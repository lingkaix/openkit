import { type CoreClient, createCoreClient } from '@openkit/core-client';
import { useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

/**
 * Core-client wiring (rebuild-stack data boundary). The Web UI consumes the
 * server ONLY through the composed `@openkit/core-client` sub-clients, and all
 * reads/mutations flow through TanStack Query — server state is never duplicated
 * into Zustand.
 */

const CoreClientContext = createContext<CoreClient | null>(null);

/** One live transport failure and the exact retry action that owns it. */
interface ConnectionFailure {
  owner: object;
  retry: () => void;
}

/** Shared operations for reporting and clearing the current live transport failure. */
interface ConnectionFailureContextValue {
  failure: ConnectionFailure | null;
  report: (owner: object, retry: () => void) => void;
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
  const report = useCallback((owner: object, retry: () => void) => {
    setFailure({ owner, retry });
  }, []);
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
  /** The runtime is reachable. */
  connected: boolean;
  /** The first probe is still in flight. */
  checking: boolean;
  /** The runtime could not be reached. */
  failed: boolean;
  /** Retry the probe now. */
  retry: () => void;
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
  const query = useQuery({
    queryKey: ['core', 'meta'],
    queryFn: () => client.core.meta(),
    retry: 1,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
  return {
    connected: query.isSuccess && !stream.failure,
    checking: query.isLoading,
    failed: query.isError || Boolean(stream.failure),
    retry: () => {
      void query.refetch();
      stream.failure?.retry();
    },
  };
}
