import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { CoreClientProvider, getDefaultCoreClient } from './core-client';

/**
 * Application providers.
 *
 * TanStack Query owns all server state read through `@openkit/core-client`;
 * React Router owns routing; the CoreClient is provided via context. UI-only
 * state lives in Zustand stores (see `app/theme-store.ts`) and is never
 * duplicated here. This boundary is fixed by
 * docs/specs/20260710-web_ui_rebuild_stack.md.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1 } } });
}

export interface AppProvidersProps {
  children: ReactNode;
  /** Override the CoreClient (tests supply a fake). */
  client?: CoreClient;
  /** Override the QueryClient (tests supply a fresh, isolated one). */
  queryClient?: QueryClient;
}

export function AppProviders({ children, client, queryClient }: AppProvidersProps) {
  const qc = queryClient ?? createQueryClient();
  const core = client ?? getDefaultCoreClient();
  return (
    <QueryClientProvider client={qc}>
      <CoreClientProvider client={core}>
        <BrowserRouter>{children}</BrowserRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}
