import type { ReactNode } from 'react';
import { useLayoutEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { EmptyState, Page, PageHeader } from '../primitives';
import { AccountBoundary, AccountScreen } from '../screens/account';
import { ArtifactsScreen } from '../screens/artifacts';
import { AutomationsScreen } from '../screens/automations';
import { ChatStarter } from '../screens/chat';
import { SteerFixtureScreen } from '../screens/chat/timeline/SteerFixtureScreen';
import { TimelineFixtureScreen } from '../screens/chat/timeline/TimelineFixtureScreen';
import { GenerativeScreen } from '../screens/generative';
import { ArtifactReviewScreen } from '../screens/goal';
import { MaterialScreen } from '../screens/material';
import { RecoveryScreen } from '../screens/operations';
import { PortabilityScreen } from '../screens/portability';
import { SearchScreen } from '../screens/search/SearchScreen';
import {
  AccessTokensScreen,
  AdministrationScreen,
  AiInterfaceScreen,
  AppearanceScreen,
  AppUpdateScreen,
  ChannelsScreen,
  ConfigurationScreen,
  DataRootBackupScreen,
  DiagnosticsScreen,
  DisableUserScreen,
  GeneralSettingsScreen,
  MyAdminAccessScreen,
  ServerAuditScreen,
  ServerOperationsScreen,
  SharedMcpScreen,
  UsageScreen,
  VaultAdminScreen,
  VaultScreen,
  WorkspaceAccessRecoveryScreen,
} from '../screens/settings';
import {
  AgentsScreen,
  ArchivedThreadsScreen,
  CatalogScreen,
  FirstRunScreen,
  KnowledgeScreen,
  NewWorkspaceScreen,
  OverviewScreen,
} from '../screens/workspace';
import { WorkspaceChangesScreen } from '../screens/workspace-sync';
import { AppShell } from './AppShell';
import { AssistantHome } from './AssistantHome';
import { AssistantRoute } from './AssistantRoute';
import { isSurfaceLive } from './flags';
import { legacyTarget } from './legacy-routes';
import { SURFACES, type Surface } from './surfaces';
import { ThreadRoute } from './ThreadRoute';
import { useDocumentTheme } from './theme-store';
import { WorkScreen } from './WorkScreen';

function NotFound() {
  return (
    <Page>
      <PageHeader title="Not found" />
      <EmptyState
        icon="search"
        title="This page doesn't exist"
        hint="Check the address, or head back to Needs you."
      />
    </Page>
  );
}

/**
 * Every surface catalog id must have a concrete screen. The catalog and this
 * map are the dual of each other — a missing entry is a program bug, not a
 * placeholder (WP-10 dead-asset sweep). Exported for the catalog-coverage test.
 */
export const SURFACE_ELEMENTS: Record<string, ReactNode> = {
  administration: <AdministrationScreen />,
  diagnostics: <DiagnosticsScreen />,
  account: <AccountScreen />,
  appearance: <AppearanceScreen />,
  configuration: <ConfigurationScreen />,
  'app-update': <AppUpdateScreen />,
  settings: <GeneralSettingsScreen />,
  'ai-interface': <AiInterfaceScreen />,
  'my-admin-access': <MyAdminAccessScreen />,
  'access-tokens': <AccessTokensScreen />,
  'server-audit': <ServerAuditScreen />,
  'server-operations': <ServerOperationsScreen />,
  'data-root-backup': <DataRootBackupScreen />,
  'shared-mcp': <SharedMcpScreen />,
  'vault-admin': <VaultAdminScreen />,
  'workspace-access-recovery': <WorkspaceAccessRecoveryScreen />,
  'disable-user': <DisableUserScreen />,
  assistant: <AssistantRoute />,
  new: <ChatStarter />,
  search: <SearchScreen />,
  thread: <ThreadRoute />,
  'artifact-review': <ArtifactReviewScreen />,
  material: <MaterialScreen />,
  'needs-you': <OverviewScreen />,
  agents: <AgentsScreen />,
  catalog: <CatalogScreen />,
  knowledge: <KnowledgeScreen />,
  artifacts: <ArtifactsScreen />,
  'first-run': <FirstRunScreen />,
  'new-workspace': <NewWorkspaceScreen />,
  'archived-threads': <ArchivedThreadsScreen />,
  automations: <AutomationsScreen />,
  'workspace-changes': <WorkspaceChangesScreen />,
  portability: <PortabilityScreen />,
  recovery: <RecoveryScreen />,
  channels: <ChannelsScreen />,
  vault: <VaultScreen />,
  usage: <UsageScreen />,
  generative: <GenerativeScreen />,
};

/**
 * Host shared by a retired address and its catalog screen.
 *
 * Necessity: each path is its own route, and a second screen detaches a field already in use.
 * Ablation: `<Navigate>` paints an empty frame, then mounts that second screen.
 */
function AliasedScreen({ to, children }: { to?: string; children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    if (to && pathname !== to) navigate(to, { replace: true });
  }, [navigate, pathname, to]);
  return children;
}

/** A moved Settings address: replaced by its current one, keeping search and hash. */
function MovedTo({ to, from }: { to: string; from: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: to, search, hash }} replace state={{ movedFrom: from }} />;
}

/** A retired address (WEB-UX B1): replaced by its current one, keeping search, hash and state. */
function LegacyRedirect() {
  const { pathname, search, hash, state } = useLocation();
  const target = legacyTarget(pathname, search, hash);
  if (!target) return <NotFound />;
  const kept = state && typeof state === 'object' ? state : {};
  return <Navigate to={target.to} replace state={{ ...kept, ...target.state }} />;
}

/**
 * The concrete element for a cataloged surface.
 */
function elementFor(surface: Surface) {
  const content = SURFACE_ELEMENTS[surface.id];
  if (!content) {
    throw new Error(`No screen registered for surface "${surface.id}" (board ${surface.board}).`);
  }
  if (surface.id === 'settings' || surface.id === 'ai-interface') {
    return <AliasedScreen>{content}</AliasedScreen>;
  }
  return content;
}

/**
 * Route tree (DESIGN.md §3, §11). Every board frame resolves to a route under the
 * app shell; the catalog is the single source so navigation and routing never
 * drift. Wide content scrolls within the main region, never the body.
 */
export function AppRoutes() {
  useDocumentTheme();
  return (
    <AccountBoundary>
      <Routes>
        {import.meta.env.DEV ? (
          <Route path="/__timeline-fixture" element={<TimelineFixtureScreen />} />
        ) : null}
        {import.meta.env.DEV ? (
          <Route path="/__steer-fixture" element={<SteerFixtureScreen />} />
        ) : null}
        <Route element={<AppShell />}>
          <Route element={<AssistantHome />}>
            <Route path="/" />
            <Route path="/needs-you" />
            <Route path="/attention" />
          </Route>
          <Route path="/work" element={<WorkScreen />} />
          {SURFACES.filter((surface) => isSurfaceLive(surface) && surface.id !== 'needs-you').map(
            (surface) => (
              <Route key={surface.id} path={surface.path} element={elementFor(surface)} />
            )
          )}
          <Route path="/chat" element={<LegacyRedirect />} />
          <Route path="/chat/:workspaceId/:threadId/*" element={<LegacyRedirect />} />
          <Route path="/tasks/:workspaceId/:threadId/*" element={<LegacyRedirect />} />
          <Route path="/goals/:workspaceId/:threadId/*" element={<LegacyRedirect />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/settings" element={<Navigate to="/settings/account" replace />} />
          <Route path="/settings/appearance/components" element={SURFACE_ELEMENTS.appearance} />
          <Route
            path="/settings/debug"
            element={<MovedTo to="/settings/diagnostics" from="/settings/debug" />}
          />
          <Route
            path="/settings/ai-interface"
            element={
              <AliasedScreen to="/settings/gateway">
                {SURFACE_ELEMENTS['ai-interface']}
              </AliasedScreen>
            }
          />
          <Route
            path="/workspace"
            element={
              <AliasedScreen to="/settings/general">{SURFACE_ELEMENTS.settings}</AliasedScreen>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </AccountBoundary>
  );
}
