import {
  AuthSignOutResponseSchema,
  OPERATION_DEFINITIONS,
  type OperationId,
  operationHttpPath,
  ThreadDashboardResponseSchema,
  ThreadTimelineResponseSchema,
} from '@openkit/app-api-schemas';
import { type CoreClient, createCoreClient } from '@openkit/core-client';
import {
  ApiErrorSchema,
  PROTOCOL_VERSION,
  ProductTurnSchema,
  ThreadSchema,
} from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { useAccountMutation } from '../../account/session';
import { ThreadStream } from '../ThreadStream';
import { clearDashboardClockSamples } from './clock-offset';
import { useCorrectedTimelineNow } from './time';

// Conversation Timeline U5 / TWPC1-FIX: one clock domain per subtraction.
// Real SDK, hooks and renderer; only HTTP, browser APIs and the wall clock are doubled.
const WS = 'ws_00000000-0000-7000-8000-0000000000c1';
const THREAD = 'th_00000000-0000-7000-8000-0000000000c1';
const TURN = 'tu_00000000-0000-7000-8000-0000000000c1';
const ITEM = 'it_00000000-0000-7000-8000-0000000000c1';
const VIEWER = 'usr_00000000-0000-7000-8000-0000000000c1';
const SERVER = Date.parse('2026-11-13T03:00:00.000Z');
const MINUTE = 60 * 1000;
const owner = { kind: 'workspace' as const, workspaceId: WS };

const timeline = ThreadTimelineResponseSchema.parse({
  workspaceId: WS,
  threadId: THREAD,
  view: 'runs',
  runs: [],
  items: [],
  beforeCursor: null,
  afterCursor: null,
  itemWindow: null,
  anchor: null,
  catchUpAnchor: null,
  earlierUnread: null,
  digest: { lines: [], coverage: 'complete' },
  restrictedReferences: false,
});

function dashboard(serverTime: string | null) {
  const started = new Date(SERVER - 40 * MINUTE).toISOString();
  return ThreadDashboardResponseSchema.parse({
    ...(serverTime ? { serverTime } : {}),
    viewerUserId: VIEWER,
    participants: [],
    thread: ThreadSchema.parse({
      id: THREAD,
      owner,
      name: 'Clock',
      preview: 'Clock',
      status: 'active',
      entryPath: 'conversation',
      visibility: 'workspace',
      createdAt: started,
      updatedAt: started,
    }),
    turns: [
      ProductTurnSchema.parse({
        id: TURN,
        owner,
        threadId: THREAD,
        triggerActor: { kind: 'user', id: VIEWER },
        items: [],
        error: null,
        configVersion: null,
        startedAt: started,
        completedAt: null,
        durationMs: null,
        status: 'running',
      }),
    ],
    now: {
      turnId: TURN,
      status: 'running',
      step: {
        itemId: ITEM,
        kind: 'command-execution',
        title: null,
        startedAt: started,
      },
      lastEventAt: started,
      queuePosition: null,
      stepsReportedLive: true,
    },
    artifacts: [],
    workStatus: {
      selectedAgentId: null,
      activeTurnStatus: 'running',
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

const transportErrors: string[] = [];
const caches: QueryClient[] = [];
const io = { failTimeline: false, run: false, dashboardReads: 0 };
function runPage() {
  return ThreadTimelineResponseSchema.parse({
    ...timeline,
    runs: [
      {
        id: TURN,
        admissionOrder: 1,
        status: 'running',
        triggerActor: { kind: 'user', id: VIEWER },
        agentId: null,
        triggerSource: null,
        startedAt: new Date(SERVER - 40 * MINUTE).toISOString(),
        completedAt: null,
        durationMs: null,
        error: null,
        long: true,
        narrative: [],
        plan: null,
        noteItemIds: [],
        finalItemId: null,
        narrativeCursor: null,
        statistics: {
          steps: 1,
          failedStepCount: 0,
          failedCommandCount: 0,
          filesChanged: 0,
          messages: 0,
          itemCounts: { 'command-execution': 1 },
          coverage: 'complete',
        },
        interruptedBy: { visibility: 'available', actor: null },
        restrictedReferences: false,
      },
    ],
  });
}
function client(samples: readonly (string | null)[]): CoreClient {
  let call = 0;
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const url = new URL(
      typeof resource === 'string' || resource instanceof URL ? String(resource) : resource.url
    );
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    try {
      if (url.pathname === '/api/meta')
        return json({ protocolVersion: PROTOCOL_VERSION, capabilities: [], eventFamilies: [] });
      if (url.pathname === '/api/auth/sign-out')
        return json(AuthSignOutResponseSchema.parse({ success: true }));
      if (url.pathname === `/api/workspaces/${WS}/threads/${THREAD}/events`) {
        let closed = false;
        return new Response(
          new ReadableStream({
            start(controller) {
              const close = () => {
                if (!closed) {
                  closed = true;
                  controller.close();
                }
              };
              if (init?.signal?.aborted) close();
              else init?.signal?.addEventListener('abort', close, { once: true });
            },
            cancel() {
              closed = true;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        );
      }
      const name = (Object.keys(OPERATION_DEFINITIONS) as OperationId[]).find(
        (op) => operationHttpPath(op) === url.pathname
      )!;
      const def = OPERATION_DEFINITIONS[name];
      if (!def) throw new Error('Unexpected HTTP path: ' + url.pathname);
      def.inputSchema.parse(JSON.parse(String(init?.body)));
      if (name === 'thread.timeline' && io.failTimeline)
        return json(
          ApiErrorSchema.parse({
            protocolVersion: PROTOCOL_VERSION,
            code: 'recovery_required',
            message: 'The timeline source is unavailable.',
          }),
          503
        );
      let body: unknown;
      if (name === 'thread.dashboard') {
        io.dashboardReads += 1;
        body = dashboard(samples[Math.min(call++, samples.length - 1)] ?? null);
      } else if (name === 'thread.timeline') body = io.run ? runPage() : timeline;
      else if (name === 'thread.items') body = { items: [], nextCursor: null };
      else if (name === 'thread.read-state')
        body = { scope: 'window', readItemIds: [], unreadItemIds: [] };
      else if (name === 'conversation.navigation') body = { items: [], nextCursor: null };
      else if (name === 'attention.list') body = { items: [] };
      else if (name === 'conversation.targets')
        body = { workspaceId: WS, threadId: THREAD, targets: [], defaultTargetRef: null };
      else throw new Error('Unexpected operation: ' + name);
      return json(def.outputSchema.parse(body));
    } catch (error) {
      transportErrors.push(String(error));
      throw error;
    }
  };
  return createCoreClient({ baseUrl: 'http://openkit.invalid', fetch });
}

function renderStream(samples: readonly (string | null)[], children?: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  caches.push(queryClient);
  const node: ReactNode = (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client(samples)}>
        <MemoryRouter>
          {children ?? <ThreadStream workspaceId={WS} threadId={THREAD} />}
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { queryClient, ...render(node) };
}

beforeEach(() => {
  io.failTimeline = false;
  io.run = false;
  io.dashboardReads = 0;
  clearDashboardClockSamples();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
  );
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width: 800'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  }));
});

afterEach(() => {
  cleanup();
  for (const cache of caches.splice(0)) cache.clear();
  clearDashboardClockSamples();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(transportErrors.splice(0), 'Every transport double is schema-valid').toEqual([]);
});

function ClockOnly({ thread = THREAD }: { thread?: string }) {
  const now = useCorrectedTimelineNow(WS, thread, true);
  return (
    <output aria-label="Scope clock">{Math.floor((now - (SERVER - 40 * MINUTE)) / MINUTE)}</output>
  );
}
function AccountBoundary() {
  const [show, setShow] = useState(true);
  const mutation = useAccountMutation();
  return (
    <>
      {show ? <ThreadStream workspaceId={WS} threadId={THREAD} /> : null}
      <ClockOnly />
      <output aria-label="Account transition">
        {mutation.isSuccess ? 'signed out' : 'active'}
      </output>
      <button
        type="button"
        onClick={async () => {
          setShow(false);
          await mutation.mutateAsync({ operation: 'signOut', email: '', password: '', name: '' });
        }}
      >
        Sign out
      </button>
    </>
  );
}
describe('C1 independent clock witnesses through real SDK transport', () => {
  it('gives the same 40-minute duration to Now and the current run summary', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SERVER + 5 * MINUTE);
    io.run = true;
    renderStream([new Date(SERVER).toISOString()]);
    expect(await screen.findByText('Running a command · 40 min')).toBeInTheDocument();
    const run = document.querySelector('[data-entry="run"]') as HTMLElement;
    expect(run).not.toBeNull();
    console.log('C1 run summary:', run.textContent);
    expect(within(run).getByText('40 min')).toBeInTheDocument();
  });
  it('measures retained refresh age in the receipt clock domain, not five minutes of skew', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SERVER - 5 * MINUTE);
    io.run = true;
    const view = renderStream([new Date(SERVER).toISOString()]);
    expect(await screen.findByText('Running a command · 40 min')).toBeInTheDocument();
    await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
    io.failTimeline = true;
    await view.queryClient.invalidateQueries({ queryKey: ['thread-timeline', WS, THREAD] });
    await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
    await screen.findByText(/^Updated .* ago$/);
    console.log(
      'C1 retained ages:',
      screen.queryAllByText(/Updated .* ago/).map((n) => n.textContent)
    );
    expect(screen.getByText('Updated 0 s ago')).toBeInTheDocument();
  });
  it('accepts a fresh admitted sample after the local wall clock moves backwards', async () => {
    let local = SERVER + 5 * MINUTE;
    vi.spyOn(Date, 'now').mockImplementation(() => local);
    const first = renderStream([new Date(SERVER).toISOString()]);
    expect(await screen.findByText('Running a command · 40 min')).toBeInTheDocument();
    first.unmount();
    first.queryClient.clear();
    local = SERVER - 5 * MINUTE;
    const next = renderStream([new Date(SERVER).toISOString()]);
    await waitFor(() => expect(next.queryClient.isFetching()).toBe(0));
    expect(io.dashboardReads).toBeGreaterThanOrEqual(2);
    console.log(
      'C1 after backward clock:',
      screen.queryAllByText(/Running a command/).map((n) => n.textContent)
    );
    expect(screen.getByText('Running a command · 40 min')).toBeInTheDocument();
  });
  it('drops the previous account offset before any next-account admission', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SERVER + 5 * MINUTE);
    renderStream([new Date(SERVER).toISOString()], <AccountBoundary />);
    expect(await screen.findByText('Running a command · 40 min')).toBeInTheDocument();
    expect(screen.getByLabelText('Scope clock')).toHaveTextContent(/^40$/);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Account transition')).toHaveTextContent('signed out')
    );
    console.log('C1 post-account scope clock:', screen.getByLabelText('Scope clock').textContent);
    expect(screen.getByLabelText('Scope clock')).toHaveTextContent(/^45$/);
  });
  it('keeps an unsampled other Thread on the client clock', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SERVER + 5 * MINUTE);
    renderStream(
      [new Date(SERVER).toISOString()],
      <>
        <ThreadStream workspaceId={WS} threadId={THREAD} />
        <ClockOnly thread="th_00000000-0000-7000-8000-0000000000c2" />
      </>
    );
    expect(await screen.findByText('Running a command · 40 min')).toBeInTheDocument();
    expect(screen.getByLabelText('Scope clock')).toHaveTextContent(/^45$/);
  });
  it('clears the offset when a fresh admitted dashboard omits the sample', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SERVER + 5 * MINUTE);
    const view = renderStream([new Date(SERVER).toISOString(), null]);
    expect(await screen.findByText('Running a command · 40 min')).toBeInTheDocument();
    await view.queryClient.invalidateQueries({ queryKey: ['thread-dashboard', WS, THREAD] });
    expect(await screen.findByText('Running a command · 45 min')).toBeInTheDocument();
  });
});
