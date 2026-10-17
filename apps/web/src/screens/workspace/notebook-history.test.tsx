import { operationHttpPath } from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { useWorkspaceStore } from '../workspace-store';
import { KnowledgeScreen } from './KnowledgeScreen';

const WORKSPACE = 'ws_00000000-0000-7000-8000-000000000001';
const OTHER = 'ws_00000000-0000-7000-8000-000000000003';
const USER = 'usr_00000000-0000-7000-8000-000000000002';
const BASE = 'a'.repeat(40);
const FROM = 'b'.repeat(40);
const PUBLISHED = 'c'.repeat(40);
const timestamp = '2026-10-16T00:00:00.000Z';
const clients: QueryClient[] = [];

/** Real hooks and public Core client replace only HTTP, including one unknown restore result. */
function renderNotebook({
  deferDiff = false,
  truncatedDiff = false,
  unknownUpdate = false,
  deniedUpdate = false,
  conflictUpdate = false,
} = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const restores: Array<Record<string, unknown>> = [];
  const diffs: Array<Record<string, unknown>> = [];
  let currentRevision = BASE;
  let historyDenied = false;
  let resolveOldDiff: (() => void) | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/meta')
      return Response.json({ protocolVersion: '1', capabilities: [], eventFamilies: [] });
    const body = JSON.parse(String(init?.body));
    switch (path) {
      case operationHttpPath('workspace.list'):
        return Response.json({
          items: [WORKSPACE, OTHER].map((workspaceId) => ({
            workspace: {
              id: workspaceId,
              name: 'Notebook team',
              kind: 'general',
              status: 'active',
              counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            membershipStatus: 'active',
            accessCause: 'membership',
            isOwner: true,
            membershipRevision: 1,
            ownerUserId: USER,
            registryRevision: 1,
          })),
        });
      case operationHttpPath('knowledge.list'):
        return Response.json({ notebookRevision: currentRevision, items: [] });
      case operationHttpPath('knowledge.indexes'):
        return Response.json({
          linkGraph: {
            schemaVersion: 1,
            workspaceId: body.workspaceId,
            rebuiltAt: null,
            edges: [],
          },
          validation: {
            schemaVersion: 1,
            workspaceId: body.workspaceId,
            rebuiltAt: null,
            records: [],
          },
          sourceReferences: {
            schemaVersion: 1,
            workspaceId: body.workspaceId,
            rebuiltAt: null,
            references: [],
          },
        });
      case operationHttpPath('knowledge.source.list'):
      case operationHttpPath('knowledge.observation.list'):
      case operationHttpPath('knowledge.claim.list'):
      case operationHttpPath('knowledge.conflict.list'):
      case operationHttpPath('attention.list'):
        return Response.json({ items: [] });
      case operationHttpPath('knowledge.notebook.history'):
        if (historyDenied)
          return Response.json({
            notebookRevision: currentRevision,
            nextRevision: null,
            revisions: [currentRevision, FROM].map((revision) => ({
              revision,
              parentRevision: null,
              availability: 'unavailable',
            })),
          });
        return Response.json({
          notebookRevision: currentRevision,
          nextRevision: null,
          revisions: [
            {
              revision: currentRevision,
              parentRevision: FROM,
              availability: 'available',
              summary: body.workspaceId === OTHER ? 'Other Workspace edit' : 'Current team edit',
              producer: { kind: 'user', id: USER },
              changedPaths: ['notes/one.md', 'notes/obsolete.md'],
            },
            {
              revision: FROM,
              parentRevision: null,
              availability: 'available',
              summary: 'Earlier human edit',
              producer: { kind: 'user', id: USER },
              changedPaths: ['notes/one.md'],
            },
            { revision: 'd'.repeat(40), parentRevision: null, availability: 'unavailable' },
          ],
        });
      case operationHttpPath('knowledge.notebook.diff'):
        diffs.push(body);
        if (historyDenied)
          return Response.json(
            { code: 'workspace_access_denied', message: 'Knowledge page is unavailable.' },
            { status: 403 }
          );
        if (deferDiff && body.workspaceId === WORKSPACE)
          return new Promise<Response>((resolve) => {
            resolveOldDiff = () =>
              resolve(
                Response.json({
                  baseRevision: body.baseRevision,
                  fromRevision: body.fromRevision,
                  forRestore: Boolean(body.forRestore),
                  truncated: truncatedDiff && !body.forRestore,
                  changes: [
                    {
                      path: 'notes/one.md',
                      before: 'Private old Workspace text.',
                      after: 'Earlier old Workspace text.',
                    },
                  ],
                })
              );
          });
        return Response.json({
          baseRevision: body.baseRevision,
          fromRevision: body.fromRevision,
          forRestore: Boolean(body.forRestore),
          truncated: truncatedDiff && !body.forRestore,
          changes: [
            {
              path: 'notes/one.md',
              before: 'Current exact text.',
              after: body.forRestore
                ? 'review_state: user-authored\nEarlier exact text.'
                : 'review_state: accepted\nEarlier exact text.',
            },
            { path: 'notes/obsolete.md', before: 'Obsolete exact text.', after: null },
          ].filter((change) => !body.pageIds || body.pageIds.includes(change.path.slice(0, -3))),
        });
      case operationHttpPath('knowledge.notebook.update'): {
        const requestId = new Headers(init?.headers).get('x-openkit-request-id');
        updates.push({ ...body, requestId });
        if (deniedUpdate) {
          historyDenied = true;
          return Response.json(
            {
              protocolVersion: PROTOCOL_VERSION,
              code: 'workspace_access_denied',
              message: 'Source access denied.',
            },
            { status: 403 }
          );
        }
        if (conflictUpdate && updates.length === 1) {
          currentRevision = 'e'.repeat(40);
          return Response.json(
            { protocolVersion: PROTOCOL_VERSION, code: 'conflict', message: 'Notebook changed.' },
            { status: 409 }
          );
        }
        if (unknownUpdate && updates.length === 1) throw new TypeError('Response lost.');
        currentRevision = PUBLISHED;
        return Response.json({
          outcome: 'published',
          ownerScope: { kind: 'workspace', workspaceId: body.workspaceId },
          baseRevision: body.baseRevision,
          notebookRevision: PUBLISHED,
          changedPageIds: ['notes/one'],
          receiptRef: {
            operation: 'knowledge.notebook.update',
            requestId,
            ownerScope: { kind: 'workspace', workspaceId: body.workspaceId },
          },
        });
      }
      case operationHttpPath('knowledge.notebook.restore'): {
        const requestId = new Headers(init?.headers).get('x-openkit-request-id');
        restores.push({ ...body, requestId });
        if (restores.length === 1) throw new TypeError('Response lost.');
        currentRevision = PUBLISHED;
        return Response.json({
          outcome: 'published',
          ownerScope: { kind: 'workspace', workspaceId: WORKSPACE },
          baseRevision: BASE,
          notebookRevision: PUBLISHED,
          changedPageIds: ['notes/one', 'notes/obsolete'],
          receiptRef: {
            operation: 'knowledge.notebook.restore',
            requestId,
            ownerScope: { kind: 'workspace', workspaceId: WORKSPACE },
          },
        });
      }
      default:
        throw new Error(`Unexpected HTTP request: ${path}`);
    }
  });
  const client = createCoreClient({ baseUrl: 'http://openkit.invalid', fetch });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(queryClient);
  render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={['/knowledge']}>
          <KnowledgeScreen />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return {
    restores,
    updates,
    diffs,
    queryClient,
    denyHistory: () => {
      historyDenied = true;
    },
    hasDeferredDiff: () => Boolean(resolveOldDiff),
    resolveOldDiff: () => resolveOldDiff?.(),
  };
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe('Notebook history and restore', () => {
  it('labels a truncated display and requests a complete preview only for the selected pages', async () => {
    const user = userEvent.setup();
    const f = renderNotebook({ truncatedDiff: true });
    await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
    await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
    expect(await screen.findByText(/This diff is truncated/)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Edit current notes/one.md' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review restore' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /notes\/obsolete.md/ }));
    await user.click(screen.getByRole('button', { name: 'Prepare restore' }));
    await screen.findByRole('region', { name: 'Restored notes/one.md' });
    expect(f.diffs.at(-1)).toMatchObject({ forRestore: true, pageIds: ['notes/one'] });
    expect(screen.queryByText(/This diff is truncated/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Restored notes/obsolete.md' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review restore' })).toBeEnabled();
    expect(f.restores).toHaveLength(0);
  });

  it('withholds a cached diff when refreshed history and current page access become unavailable', async () => {
    const user = userEvent.setup();
    const f = renderNotebook();
    await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
    await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
    await screen.findByRole('region', { name: 'Historical notes/one.md' });
    await user.click(screen.getByRole('button', { name: 'Edit current notes/one.md' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Page text/Markdown' }), {
      target: { value: 'REVOKED-DRAFT-MARKER' },
    });
    f.denyHistory();
    await user.click(screen.getByRole('button', { name: 'Refresh history' }));
    await waitFor(() => expect(screen.getAllByText('Unavailable revision')).toHaveLength(2));
    expect(
      screen.queryByRole('region', { name: 'Historical notes/one.md' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Current exact text.')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Page text/Markdown' })).not.toBeInTheDocument();
    expect(screen.queryByText('REVOKED-DRAFT-MARKER')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare restore' })).not.toBeInTheDocument();
    await waitFor(() => expect(f.diffs).toHaveLength(2));
    expect(f.restores).toHaveLength(0);
  });

  it('shows exact normalized changes and removal before confirmation, then retries the identical command after an unknown result', async () => {
    const user = userEvent.setup();
    const f = renderNotebook();
    await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
    await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
    await screen.findByRole('region', { name: 'Historical notes/one.md' });
    expect(screen.getByRole('region', { name: 'Historical notes/one.md' })).toHaveTextContent(
      'review_state: accepted'
    );
    await user.click(screen.getByRole('button', { name: 'Prepare restore' }));
    await screen.findByRole('region', { name: 'Restored notes/one.md' });
    expect(screen.getByRole('region', { name: 'Current notes/one.md' })).toHaveTextContent(
      'Current exact text.'
    );
    expect(screen.getByRole('region', { name: 'Restored notes/one.md' })).toHaveTextContent(
      'review_state: user-authored'
    );
    expect(screen.getByText('Unavailable revision')).toBeVisible();
    expect(f.restores).toHaveLength(0);
    expect(f.diffs.find((diff) => diff.forRestore === true)).toMatchObject({
      workspaceId: WORKSPACE,
      baseRevision: BASE,
      fromRevision: FROM,
      forRestore: true,
    });
    await user.click(screen.getByRole('button', { name: 'Review restore' }));
    const dialog = screen.getByRole('dialog', { name: 'Restore Notebook pages' });
    expect(within(dialog).getByText(/notes\/obsolete.md/)).toBeVisible();
    expect(within(dialog).getByText(/remove/i)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Confirm restore' }));
    await screen.findByText(
      'Restore result is unknown. Retry the same request or inspect history.'
    );
    expect(f.restores).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Retry restore' }));
    await waitFor(() => expect(f.restores).toHaveLength(2));
    expect(f.restores[1]).toEqual(f.restores[0]);
    expect(f.restores[0]).toMatchObject({
      workspaceId: WORKSPACE,
      baseRevision: BASE,
      fromRevision: FROM,
      pageIds: ['notes/one', 'notes/obsolete'],
      confirmRemoval: true,
    });
    expect(f.restores[0]?.requestId).toEqual(expect.any(String));
    await screen.findByText('Selected pages were restored in a new revision.');
  });

  it('clears the selected revision on a Workspace switch and never renders a late old-scope diff', async () => {
    const user = userEvent.setup();
    const f = renderNotebook({ deferDiff: true });
    await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
    await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
    await waitFor(() => expect(f.hasDeferredDiff()).toBe(true));
    act(() => useWorkspaceStore.setState({ currentWorkspaceId: OTHER }));
    await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
    await screen.findByRole('radio', { name: 'Other Workspace edit' });
    await act(async () => f.resolveOldDiff());
    expect(screen.queryByText('Private old Workspace text.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review restore' })).not.toBeInTheDocument();
    expect(f.restores).toHaveLength(0);
  });
});

describe('Notebook current page editing', () => {
  it('publishes exact current page bytes and a fixed base through the composed client, then refreshes dependent views', async () => {
    const user = userEvent.setup();
    const f = renderNotebook({ conflictUpdate: true });
    const invalidate = vi.spyOn(f.queryClient, 'invalidateQueries');
    await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
    await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
    await user.click(await screen.findByRole('button', { name: 'Edit current notes/one.md' }));
    const text = screen.getByRole('textbox', { name: 'Page text/Markdown' });
    expect(text).toHaveValue('Current exact text.');
    const edited = '---\ncustom: {preserved: true}\n---\nExact edited page.\n';
    fireEvent.change(text, { target: { value: edited } });
    await user.type(screen.getByRole('textbox', { name: 'Edit summary' }), 'Correct the page');
    expect(screen.getByRole('region', { name: 'Current page text' })).toHaveTextContent(
      'Current exact text.'
    );
    expect(screen.getByRole('region', { name: 'Edited page text' }).textContent).toBe(edited);
    await user.click(screen.getByRole('button', { name: 'Apply page edit' }));
    await screen.findByText(
      'The Notebook changed. This edit was refused. Inspect current history and start a new edit.'
    );
    expect(screen.getByRole('textbox', { name: 'Page text/Markdown' })).toHaveValue(edited);
    expect(screen.getByRole('textbox', { name: 'Page text/Markdown' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Apply page edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry saved page edit' })).not.toBeInTheDocument();
    expect(f.updates).toEqual([
      {
        workspaceId: WORKSPACE,
        baseRevision: BASE,
        changes: [{ path: 'notes/one.md', content: edited }],
        summary: 'Correct the page',
        requestId: expect.any(String),
      },
    ]);
    await user.click(
      screen.getByRole('button', { name: 'Close edit and inspect current history' })
    );
    await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
    await user.click(await screen.findByRole('button', { name: 'Edit current notes/one.md' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Page text/Markdown' }), {
      target: { value: edited },
    });
    await user.type(screen.getByRole('textbox', { name: 'Edit summary' }), 'Correct the page');
    await user.click(screen.getByRole('button', { name: 'Apply page edit' }));
    await screen.findByText('Page was published in a new revision.');
    expect(f.updates).toHaveLength(2);
    expect(f.updates[1]).toMatchObject({
      workspaceId: WORKSPACE,
      baseRevision: 'e'.repeat(40),
      changes: [{ path: 'notes/one.md', content: edited }],
      summary: 'Correct the page',
    });
    expect(f.updates[1]?.requestId).not.toBe(f.updates[0]?.requestId);
    for (const key of [
      ['knowledge', WORKSPACE],
      ['knowledge-indexes', WORKSPACE],
      ['attention', WORKSPACE],
    ])
      expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    expect(screen.queryByRole('textbox', { name: 'Page text/Markdown' })).not.toBeInTheDocument();
  });

  it('refuses oversized edits without clipping and retries an unknown result with only the saved identical command', async () => {
    const user = userEvent.setup();
    const f = renderNotebook({ unknownUpdate: true });
    await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
    await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
    await user.click(await screen.findByRole('button', { name: 'Edit current notes/one.md' }));
    const text = screen.getByRole('textbox', { name: 'Page text/Markdown' });
    const summary = screen.getByRole('textbox', { name: 'Edit summary' });
    const tooLarge = 'x'.repeat(2 * 1024 * 1024 + 1);
    fireEvent.change(text, { target: { value: tooLarge } });
    expect(text).toHaveValue(tooLarge);
    expect(screen.getByRole('button', { name: 'Apply page edit' })).toBeDisabled();
    fireEvent.change(text, { target: { value: 'Saved exact draft.' } });
    fireEvent.change(summary, { target: { value: 'é'.repeat(2049) } });
    expect(screen.getByRole('button', { name: 'Apply page edit' })).toBeDisabled();
    fireEvent.change(summary, { target: { value: 'Fixed summary' } });
    await user.click(screen.getByRole('button', { name: 'Apply page edit' }));
    await screen.findByText(/Page edit result is unknown.*connection or response failure/);
    expect(text).toBeDisabled();
    expect(summary).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Retry saved page edit' }));
    await screen.findByText('Page was published in a new revision.');
    expect(f.updates).toHaveLength(2);
    expect(f.updates[1]).toEqual(f.updates[0]);
    expect(f.updates[0]).toMatchObject({
      baseRevision: BASE,
      changes: [{ path: 'notes/one.md', content: 'Saved exact draft.' }],
      summary: 'Fixed summary',
      requestId: expect.any(String),
    });
  });

  it('hides draft and preview bytes on direct denial, refreshed denial and Workspace changes', async () => {
    const user = userEvent.setup();
    const f = renderNotebook({ deniedUpdate: true });
    await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
    await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
    await user.click(await screen.findByRole('button', { name: 'Edit current notes/one.md' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Page text/Markdown' }), {
      target: { value: 'PRIVATE-DRAFT-MARKER' },
    });
    act(() => useWorkspaceStore.setState({ currentWorkspaceId: OTHER }));
    await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
    expect(screen.queryByRole('textbox', { name: 'Page text/Markdown' })).not.toBeInTheDocument();
    expect(screen.queryByText('PRIVATE-DRAFT-MARKER')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
    await user.click(await screen.findByRole('button', { name: 'Edit current notes/one.md' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Page text/Markdown' }), {
      target: { value: 'DENIED-DRAFT-MARKER' },
    });
    await user.type(screen.getByRole('textbox', { name: 'Edit summary' }), 'Correct page');
    await user.click(screen.getByRole('button', { name: 'Apply page edit' }));
    await screen.findByText('Page access was denied. Read current history before another edit.');
    expect(screen.queryByText('PRIVATE-DRAFT-MARKER')).not.toBeInTheDocument();
    expect(screen.queryByText('Current exact text.')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Page text/Markdown' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Unavailable revision')).toHaveLength(2));
    expect(f.updates).toHaveLength(1);
    expect(screen.queryByText('DENIED-DRAFT-MARKER')).not.toBeInTheDocument();
    expect(f.updates[0]).toMatchObject({ workspaceId: OTHER });
    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE }));
    await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
    expect(screen.queryByText('PRIVATE-DRAFT-MARKER')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry saved page edit' })).not.toBeInTheDocument();
  });
});
