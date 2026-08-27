import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import { EmptyState, Gallery, Page, PageHeader } from '../primitives';
import { AccountBoundary, AccountScreen } from '../screens/account';
import { ChatStarter, ThreadScreen } from '../screens/chat';
import { AutomationsScreen, ChannelsScreen } from '../screens/demos';
import { GenerativeScreen } from '../screens/generative';
import { ArtifactReviewScreen, GoalScreen } from '../screens/goal';
import { MaterialScreen } from '../screens/material';
import {
  AiInterfaceScreen,
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
import { AppShell } from './AppShell';
import { ConceptDemo } from './ConceptDemo';
import { isSurfaceLive } from './flags';
import { SURFACES, type Surface } from './surfaces';
import { ThemePicker } from './ThemePicker';

/** The board 11 component sheet, mounted at a developer route (built in WP-2). */
function ComponentsScreen() {
  return (
    <Page>
      <PageHeader
        eyebrow="Board 11"
        title="Components"
        subtitle="The OpenKit primitive tier and A2UI catalog seed."
      />
      <Gallery />
    </Page>
  );
}

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
  components: <ComponentsScreen />,
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
  'first-run': <FirstRunScreen />,
  'new-workspace': <NewWorkspaceScreen />,
  automations: <AutomationsScreen />,
  repositories: <RepositoriesScreen />,
  channels: <ChannelsScreen />,
  vault: <VaultScreen />,
  usage: <UsageScreen />,
  generative: <GenerativeScreen />,
};

/**
 * The concrete element for a surface. Tier-B/C surfaces always render inside the
 * inert concept-demo wrapper (DESIGN.md §11).
 */
function elementFor(surface: Surface) {
  const content = SURFACE_ELEMENTS[surface.id];
  if (!content) {
    throw new Error(`No screen registered for surface "${surface.id}" (board ${surface.board}).`);
  }
  if (isSurfaceLive(surface)) return content;
  return <ConceptDemo surface={surface}>{content}</ConceptDemo>;
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
          {SURFACES.map((surface) => (
            <Route key={surface.id} path={surface.path} element={elementFor(surface)} />
          ))}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </AccountBoundary>
  );
}
