import { ThreadDashboardResponseSchema } from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { ProductTurnSchema, ThreadSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { RunEnvironment } from './environment';

const WS = 'ws_00000000-0000-7000-8000-0000000000d1';
const THREAD = 'th_00000000-0000-7000-8000-0000000000d1';
const CURRENT = 'tu_00000000-0000-7000-8000-0000000000d1';
const OLDER = 'tu_00000000-0000-7000-8000-0000000000d2';
const VIEWER = 'usr_00000000-0000-7000-8000-0000000000d1';
const AT = '2026-11-13T03:00:00.000Z';
const owner = { kind: 'workspace' as const, workspaceId: WS };

function dashboard(environment: Record<string, unknown> | null) {
  return ThreadDashboardResponseSchema.parse({
    viewerUserId: VIEWER,
    participants: [],
    thread: ThreadSchema.parse({
      id: THREAD,
      owner,
      name: 'Notes',
      preview: 'Notes',
      status: 'active',
      entryPath: 'conversation',
      visibility: 'workspace',
      createdAt: AT,
      updatedAt: AT,
    }),
    turns: [
      ProductTurnSchema.parse({
        id: CURRENT,
        owner,
        threadId: THREAD,
        triggerActor: { kind: 'user', id: VIEWER },
        items: [],
        error: null,
        configVersion: null,
        startedAt: AT,
        completedAt: AT,
        durationMs: 60_000,
        status: 'completed',
      }),
    ],
    ...(environment ? { environment } : {}),
    artifacts: [],
    workStatus: {
      selectedAgentId: null,
      activeTurnStatus: 'completed',
      pendingApprovalCount: 0,
      pendingQuestionCount: 0,
      latestArtifact: null,
    },
    composer: { disabled: false, defaultAgentId: null },
    itemLog: { href: '/api/app/operations/thread.timeline' },
    taskInputs: [],
    pendingRequests: [],
  });
}

function client(environment: Record<string, unknown> | null): {
  coreClient: CoreClient;
  reads: () => number;
} {
  let reads = 0;
  return {
    reads: () => reads,
    coreClient: {
      core: { meta: async () => ({}) },
      operations: {
        'thread.dashboard': async () => {
          reads += 1;
          return dashboard(environment);
        },
      },
    } as unknown as CoreClient,
  };
}

function renderFacts(environment: Record<string, unknown> | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const transport = client(environment);
  const node: ReactNode = (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={transport.coreClient}>
        <div>
          <div data-testid="current">
            <RunEnvironment turnId={CURRENT} workspaceId={WS} threadId={THREAD} />
          </div>
          <div data-testid="older">
            <RunEnvironment turnId={OLDER} workspaceId={WS} threadId={THREAD} />
          </div>
        </div>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { reads: transport.reads, ...render(node) };
}

async function settled(reads: () => number) {
  await waitFor(() => expect(reads()).toBeGreaterThan(0));
}

afterEach(cleanup);

const admitted = {
  visibility: 'available',
  observationAvailability: 'available',
  observation: {
    phase: 'heartbeat',
    outcome: 'running',
    placement: 'local',
    observedAt: AT,
    ageSeconds: 20,
  },
  model: { id: 'Northwind', source: 'turn-admission' },
};

describe('current-run observation and model', () => {
  it('shows the matching run only and does not call the observation running', async () => {
    const view = renderFacts(admitted);
    await settled(view.reads);
    const current = within(await screen.findByTestId('current'));
    expect(await current.findByText('heartbeat 20 s ago · local')).toBeInTheDocument();
    expect(current.getByText('Northwind')).toBeInTheDocument();
    expect(current.queryByText(/running/i)).not.toBeInTheDocument();

    const older = within(screen.getByTestId('older'));
    expect(older.getAllByText('unavailable')).toHaveLength(2);
    expect(older.queryByText('Northwind')).not.toBeInTheDocument();
    expect(older.queryByText(/heartbeat/)).not.toBeInTheDocument();
  });

  it('says unavailable when the matching run has no observation or model', async () => {
    const view = renderFacts({
      visibility: 'available',
      observationAvailability: 'unavailable',
      observation: null,
      model: null,
    });
    await settled(view.reads);
    const current = within(await screen.findByTestId('current'));
    expect(current.getAllByText('unavailable')).toHaveLength(2);
  });

  it('does not invent facts when the dashboard omits the environment', async () => {
    const view = renderFacts(null);
    await settled(view.reads);
    const current = within(await screen.findByTestId('current'));
    expect(current.getAllByText('unavailable')).toHaveLength(2);
    expect(screen.queryByText('Northwind')).not.toBeInTheDocument();
  });
});
