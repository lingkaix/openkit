import { operationHttpPath } from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { useWorkspaceStore } from '../workspace-store';
import { KnowledgeScreen } from './KnowledgeScreen';

const WORKSPACE = 'ws_00000000-0000-7000-8000-000000000001';
const USER = 'usr_00000000-0000-7000-8000-000000000002';
const BASE = 'a'.repeat(40);
const FROM = 'b'.repeat(40);
const PUBLISHED = 'c'.repeat(40);
const timestamp = '2026-10-16T00:00:00.000Z';
const clients: QueryClient[] = [];

/** Real hooks and public Core client replace only HTTP, including one unknown restore result. */
function renderNotebook() {
  const restores: Array<Record<string, unknown>> = [];
  const diffs: Array<Record<string, unknown>> = [];
  let currentRevision = BASE;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/meta')
      return Response.json({ protocolVersion: '1', capabilities: [], eventFamilies: [] });
    const body = JSON.parse(String(init?.body));
    switch (path) {
      case operationHttpPath('workspace.list'):
        return Response.json({ items: [{
          workspace: { id: WORKSPACE, name: 'Notebook team', kind: 'general', status: 'active', counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 }, createdAt: timestamp, updatedAt: timestamp },
          membershipStatus: 'active', accessCause: 'membership', effectiveRole: 'owner', membershipRevision: 1, ownerUserId: USER, registryRevision: 1,
        }] });
      case operationHttpPath('knowledge.list'):
        return Response.json({ notebookRevision: currentRevision, items: [] });
      case operationHttpPath('knowledge.indexes'):
        return Response.json({
          linkGraph: { schemaVersion: 1, workspaceId: WORKSPACE, rebuiltAt: null, edges: [] },
          validation: { schemaVersion: 1, workspaceId: WORKSPACE, rebuiltAt: null, records: [] },
          sourceReferences: { schemaVersion: 1, workspaceId: WORKSPACE, rebuiltAt: null, references: [] },
        });
      case operationHttpPath('knowledge.source.list'):
      case operationHttpPath('knowledge.observation.list'):
      case operationHttpPath('knowledge.claim.list'):
      case operationHttpPath('knowledge.conflict.list'):
      case operationHttpPath('attention.list'):
        return Response.json({ items: [] });
      case operationHttpPath('knowledge.notebook.history'):
        return Response.json({ notebookRevision: currentRevision, nextRevision: null, revisions: [
          { revision: currentRevision, parentRevision: FROM, availability: 'available', summary: 'Current team edit', producer: { kind: 'user', id: USER }, changedPaths: ['notes/one.md', 'notes/obsolete.md'] },
          { revision: FROM, parentRevision: null, availability: 'available', summary: 'Earlier human edit', producer: { kind: 'user', id: USER }, changedPaths: ['notes/one.md'] },
          { revision: 'd'.repeat(40), parentRevision: null, availability: 'unavailable' },
        ] });
      case operationHttpPath('knowledge.notebook.diff'):
        diffs.push(body);
        return Response.json({ baseRevision: body.baseRevision, fromRevision: body.fromRevision, forRestore: true, changes: [
          { path: 'notes/one.md', before: 'Current exact text.', after: 'review_state: user-authored\nEarlier exact text.' },
          { path: 'notes/obsolete.md', before: 'Obsolete exact text.', after: null },
        ] });
      case operationHttpPath('knowledge.notebook.restore'): {
        const requestId = new Headers(init?.headers).get('x-openkit-request-id');
        restores.push({ ...body, requestId });
        if (restores.length === 1) throw new TypeError('Response lost.');
        currentRevision = PUBLISHED;
        return Response.json({ outcome: 'published', ownerScope: { kind: 'workspace', workspaceId: WORKSPACE }, baseRevision: BASE, notebookRevision: PUBLISHED, changedPageIds: ['notes/one', 'notes/obsolete'], receiptRef: { operation: 'knowledge.notebook.restore', requestId, ownerScope: { kind: 'workspace', workspaceId: WORKSPACE } } });
      }
      default:
        throw new Error(`Unexpected HTTP request: ${path}`);
    }
  });
  const client = createCoreClient({ baseUrl: 'http://openkit.invalid', fetch });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(queryClient);
  render(<QueryClientProvider client={queryClient}><CoreClientProvider client={client}><MemoryRouter initialEntries={['/knowledge']}><KnowledgeScreen /></MemoryRouter></CoreClientProvider></QueryClientProvider>);
  return { restores, diffs, queryClient };
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe('Notebook history and restore', () => {
  it('shows exact normalized changes and removal before confirmation, then retries the identical command after an unknown result', async () => {
    const user = userEvent.setup();
    const f = renderNotebook();
    await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
    await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
    await screen.findByRole('region', { name: 'Restored notes/one.md' });
    expect(screen.getByRole('region', { name: 'Current notes/one.md' })).toHaveTextContent('Current exact text.');
    expect(screen.getByRole('region', { name: 'Restored notes/one.md' })).toHaveTextContent('review_state: user-authored');
    expect(screen.getByText('Unavailable revision')).toBeVisible();
    expect(f.restores).toHaveLength(0);
    expect(f.diffs[0]).toMatchObject({ workspaceId: WORKSPACE, baseRevision: BASE, fromRevision: FROM, forRestore: true });
    await user.click(screen.getByRole('button', { name: 'Review restore' }));
    const dialog = screen.getByRole('dialog', { name: 'Restore Notebook pages' });
    expect(within(dialog).getByText(/notes\/obsolete.md/)).toBeVisible();
    expect(within(dialog).getByText(/remove/i)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Confirm restore' }));
    await screen.findByText('Restore result is unknown. Retry the same request or inspect history.');
    expect(f.restores).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Retry restore' }));
    await waitFor(() => expect(f.restores).toHaveLength(2));
    expect(f.restores[1]).toEqual(f.restores[0]);
    expect(f.restores[0]).toMatchObject({ workspaceId: WORKSPACE, baseRevision: BASE, fromRevision: FROM, pageIds: ['notes/one', 'notes/obsolete'], confirmRemoval: true });
    expect(f.restores[0]?.requestId).toEqual(expect.any(String));
    await screen.findByText('Selected pages were restored in a new revision.');
  });
});
