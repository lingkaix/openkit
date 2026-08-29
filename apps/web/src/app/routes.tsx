import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import { EmptyState, Page, PageHeader } from '../primitives';
import { AccountBoundary, AccountScreen } from '../screens/account';
import { ArtifactsScreen } from '../screens/artifacts';
import { ChatStarter, ThreadScreen } from '../screens/chat';
import { AutomationsScreen, ChannelsScreen } from '../screens/demos';
import { GenerativeScreen } from '../screens/generative';
import { ArtifactReviewScreen, GoalScreen } from '../screens/goal';
import { MaterialScreen } from '../screens/material';
import { RecoveryScreen } from '../screens/operations';
import { PortabilityScreen } from '../screens/portability';
import {
  AiInterfaceScreen,
  DebugScreen,
  GeneralSettingsScreen,
  UsageScreen,
  VaultScreen,
} from '../screens/settings';
import {
  AgentsScreen,
  FirstRunScreen,
  KnowledgeScreen,
  NewWorkspaceScreen,
  OverviewScreen,
  RepositoriesScreen,
} from '../screens/workspace';
import { WorkspaceChangesScreen } from '../screens/workspace-sync';
import { AppShell } from './AppShell';
import { isSurfaceLive } from './flags';
import { SURFACES, type Surface } from './surfaces';
import { ThemePicker } from './ThemePicker';

function NotFound() {
  return (
    <Page>
      <PageHeader title="Not found" />
      <EmptyState
        icon="search"
        title="This page doesn't exist"
        hint="Check the address, or head back to Overview."
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
  debug: <DebugScreen />,
  account: <AccountScreen />,
  appearance: <ThemePicker />,
  settings: <GeneralSettingsScreen />,
  'ai-interface': <AiInterfaceScreen />,
  chat: <ChatStarter />,
  'chat-thread': <ThreadScreen mode="chat" />,
  'task-thread': <ThreadScreen mode="task" />,
  goal: <GoalScreen />,
  'artifact-review': <ArtifactReviewScreen />,
  material: <MaterialScreen />,
  overview: <OverviewScreen />,
  agents: <AgentsScreen />,
  knowledge: <KnowledgeScreen />,
  artifacts: <ArtifactsScreen />,
  'first-run': <FirstRunScreen />,
  'new-workspace': <NewWorkspaceScreen />,
  automations: <AutomationsScreen />,
  repositories: <RepositoriesScreen />,
  'workspace-changes': <WorkspaceChangesScreen />,
  portability: <PortabilityScreen />,
  recovery: <RecoveryScreen />,
  channels: <ChannelsScreen />,
  vault: <VaultScreen />,
  usage: <UsageScreen />,
  generative: <GenerativeScreen />,
};

/**
 * The concrete element for a cataloged surface.
 */
function elementFor(surface: Surface) {
  const content = SURFACE_ELEMENTS[surface.id];
  if (!content) {
    throw new Error(`No screen registered for surface "${surface.id}" (board ${surface.board}).`);
  }
  return content;
}

/**
 * Route tree (DESIGN.md §3, §11). Every board frame resolves to a route under the
 * app shell; the catalog is the single source so navigation and routing never
 * drift. Wide content scrolls within the main region, never the body.
 */
export function AppRoutes() {
  return (
    <AccountBoundary>
      <Routes>
        <Route element={<AppShell />}>
          {SURFACES.filter(isSurfaceLive).map((surface) => (
            <Route key={surface.id} path={surface.path} element={elementFor(surface)} />
          ))}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </AccountBoundary>
  );
}
