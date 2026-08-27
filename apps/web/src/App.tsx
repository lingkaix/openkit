import { AppRoutes } from './app/routes';

/**
 * OpenKit Web UI root.
 *
 * Renders the routed app shell (DESIGN.md §3). Providers (TanStack Query, the
 * CoreClient, and the router) are established in `app/providers.tsx`; screens are
 * composed from the primitive tier and read data via `@openkit/core-client`.
 */
export function App() {
  return <AppRoutes />;
}
