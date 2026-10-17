import { LightAppSchemaInputSchema } from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { allocateEntityId } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { LightAppDefinitions } from './LightAppDefinitions';

vi.mock('../../app/core-client', async (original) => ({
  ...(await original<typeof import('../../app/core-client')>()),
  useConnection: () => ({ checking: false, failed: false }),
}));

const workspaceId = allocateEntityId('ws');
const digest = `sha256:${'a'.repeat(64)}`;
const earlier = `sha256:${'b'.repeat(64)}`;
const appId = '1c88387c-6540-4502-a9db-a68d910b8761';
const snapshotId = '2c88387c-6540-4502-a9db-a68d910b8761';
const definition = LightAppSchemaInputSchema.parse({
  format: 'openkit.light-app',
  schemaVersion: 1,
  title: 'Notes',
  purpose: 'Keep notes',
  collections: [
    {
      name: 'notes',
      type: 'base',
      description: '',
      indexes: [],
      fields: [{ name: 'note', type: 'text', required: true, description: '' }],
    },
  ],
});
const entry = {
  id: 'notes',
  displayName: 'Notes',
  availability: 'available' as const,
  currentDigest: digest,
};
const version = {
  entryId: 'notes',
  digest,
  parentDigest: earlier,
  producer: { id: 'author', kind: 'user' as const },
  createdAt: '2026-10-17T00:00:00Z',
  definitionJson: JSON.stringify(definition),
};

/** Uses the real typed client methods as the mock boundary; no alternate API shape is introduced. */
function fixture() {
  const client = createCoreClient({ baseUrl: 'http://unused.invalid' });
  const operations = client.operations;
  vi.spyOn(operations, 'catalog.light-app-list').mockResolvedValue({
    revision: 7,
    entries: [entry],
  });
  vi.spyOn(operations, 'catalog.light-app-read').mockResolvedValue({
    revision: 7,
    entry,
    versions: [version, { ...version, digest: earlier, parentDigest: null }],
    pin: null,
  });
  vi.spyOn(operations, 'kernel.apps.list').mockResolvedValue({
    page: 1,
    perPage: 100,
    totalItems: 1,
    totalPages: 1,
    items: [
      {
        appId,
        title: 'Live notes',
        purpose: '',
        lifecycle: 'active',
        appRevision: 8,
        schemaRevision: 3,
        schemaDigest: digest,
        definitionVersion: digest,
        definitionSource: { entryId: 'notes', digest },
        kernelFormatVersion: 2,
      },
    ],
  });
  vi.spyOn(operations, 'kernel.apps.get').mockResolvedValue({
    ...liveAppFixture(),
    schema: null,
    capabilities: {
      fieldTypes: [],
      filterOperators: [],
      maxPerPage: 100,
      maxRecords: 10000,
      maxBatchEntries: 50,
      maxFilterBytes: 2048,
    },
  });
  vi.spyOn(operations, 'kernel.snapshots.list').mockResolvedValue({
    snapshots: [
      {
        snapshotId,
        createdAt: '2026-10-16T00:00:00Z',
        reason: 'definition-migration',
        appRevision: 5,
        schemaRevision: 2,
        definitionVersion: earlier,
        kernelFormatVersion: 2,
        digest,
      },
    ],
  });
  const imported = vi
    .spyOn(operations, 'catalog.light-app-import')
    .mockResolvedValue({ revision: 8, version });
  const select = vi
    .spyOn(operations, 'catalog.light-app-select')
    .mockResolvedValue({ revision: 8 });
  const activate = vi
    .spyOn(operations, 'kernel.schema.activate')
    .mockRejectedValue(new Error('refused'));
  const restore = vi
    .spyOn(operations, 'kernel.snapshots.rollback')
    .mockRejectedValue(new Error('refused'));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <LightAppDefinitions key={workspaceId} workspaceId={workspaceId} blocked={false} />
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { ...view, client, queryClient, imported, select, activate, restore };
}

/** Live revisions differ from the definition revision so the command precondition is observable. */
function liveAppFixture() {
  return {
    appId,
    title: 'Live notes',
    purpose: '',
    lifecycle: 'active' as const,
    appRevision: 8,
    schemaRevision: 3,
    schemaDigest: digest,
    definitionVersion: digest,
    definitionSource: { entryId: 'notes', digest },
    kernelFormatVersion: 2,
  };
}

describe('Light App definitions in the Workspace Catalog', () => {
  it('imports only on explicit submission, preserves the entered ID, and selects an earlier default without activation', async () => {
    const user = userEvent.setup();
    const { imported, select, activate } = fixture();
    const id = await screen.findByRole('textbox', { name: 'Light App catalog ID' });
    expect(id).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Light App display name' })).toHaveValue('');
    await user.type(id, 'my-notes');
    await user.type(screen.getByRole('textbox', { name: 'Light App display name' }), 'My notes');
    await user.upload(
      screen.getByLabelText('Definition JSON file'),
      new File([JSON.stringify(definition)], 'notes.json', { type: 'application/json' })
    );
    expect(imported).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Import definition' }));
    await waitFor(() =>
      expect(imported).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId,
          entryId: 'my-notes',
          displayName: 'My notes',
          definition,
          expectedRevision: 7,
          selectDefault: false,
        })
      )
    );
    await user.click(screen.getByRole('button', { name: 'Inspect definition Notes' }));
    await user.click(await screen.findByRole('button', { name: `Choose version ${earlier}` }));
    expect(await screen.findByText('Actor: user author')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use as default' }));
    await waitFor(() =>
      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          entryId: 'notes',
          digest: earlier,
          expectedCurrentDigest: digest,
          expectedRevision: 7,
        })
      )
    );
    expect(activate).not.toHaveBeenCalled();
  });

  it('pins and creates the exact chosen definition, then applies it with the selected app revisions', async () => {
    const user = userEvent.setup();
    const { client, activate } = fixture();
    const pin = vi
      .spyOn(client.operations, 'catalog.light-app-pin')
      .mockResolvedValue({ revision: 8 });
    const instantiate = vi
      .spyOn(client.operations, 'kernel.apps.instantiate')
      .mockRejectedValue(new Error('refused'));
    await user.click(await screen.findByRole('button', { name: 'Inspect definition Notes' }));
    await user.click(await screen.findByRole('button', { name: `Choose version ${earlier}` }));
    expect(activate).not.toHaveBeenCalled();
    expect(instantiate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Pin exact version' }));
    await waitFor(() =>
      expect(pin).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId,
          entryId: 'notes',
          digest: earlier,
          expectedPinDigest: null,
          expectedRevision: 7,
        })
      )
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create Light App' })).toBeEnabled()
    );
    await user.click(screen.getByRole('button', { name: 'Create Light App' }));
    await waitFor(() =>
      expect(instantiate).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId, entryId: 'notes', digest: earlier })
      )
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Inspect app Live notes' })).toBeEnabled()
    );
    await user.click(screen.getByRole('button', { name: 'Inspect app Live notes' }));
    const apply = await screen.findByRole('button', { name: 'Apply definition to this app' });
    await waitFor(() => expect(apply).toBeEnabled());
    await user.click(apply);
    await waitFor(() =>
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId,
          appId,
          entryId: 'notes',
          digest: earlier,
          expectedAppRevision: 8,
          expectedSchemaRevision: 3,
        })
      )
    );
  });

  it('imports historical facts without applying exported selections or live data', async () => {
    const user = userEvent.setup();
    const { client, select, activate } = fixture();
    const historyImport = vi
      .spyOn(client.operations, 'catalog.light-app-history-import')
      .mockResolvedValue({ revision: 8, entry });
    const pin = vi.spyOn(client.operations, 'catalog.light-app-pin');
    const history = {
      schemaVersion: 1,
      entry,
      versions: [version, { ...version, digest: earlier, parentDigest: null }],
      pin: { entryId: 'notes', digest: earlier },
    };
    await user.upload(
      await screen.findByLabelText('Definition history JSON file'),
      new File([JSON.stringify(history)], 'history.json', { type: 'application/json' })
    );
    expect(historyImport).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Import definition history' }));
    await waitFor(() =>
      expect(historyImport).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId,
          expectedRevision: 7,
          export: history,
        })
      )
    );
    expect(select).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it('keeps the import file and name after refusal and refresh, and blocks writes during a failed read', async () => {
    const user = userEvent.setup();
    const { imported, client, queryClient } = fixture();
    imported.mockRejectedValue(new Error('secret server detail'));
    await user.type(
      await screen.findByRole('textbox', { name: 'Light App catalog ID' }),
      'my-notes'
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Light App display name' }),
      'Unsaved notes'
    );
    await user.upload(
      screen.getByLabelText('Definition JSON file'),
      new File([JSON.stringify(definition)], 'unsaved.json', { type: 'application/json' })
    );
    await user.click(screen.getByRole('button', { name: 'Import definition' }));
    expect(
      await screen.findByText(
        "Couldn't complete that Light App change. Refresh and inspect the current state before trying again."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText('secret server detail')).not.toBeInTheDocument();
    expect(screen.getByText('Selected file: unsaved.json')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Light App display name' })).toHaveValue(
      'Unsaved notes'
    );
    vi.mocked(client.operations['catalog.light-app-list']).mockRejectedValue(
      new Error('read failed')
    );
    await queryClient.invalidateQueries({ queryKey: ['light-app-definitions', workspaceId] });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import definition' })).toBeDisabled()
    );
    expect(screen.getByText('Selected file: unsaved.json')).toBeInTheDocument();
  });

  it('requires deliberate snapshot confirmation and drops it when the definition target changes', async () => {
    const user = userEvent.setup();
    const { restore } = fixture();
    await user.click(await screen.findByRole('button', { name: 'Inspect definition Notes' }));
    await user.click(await screen.findByRole('button', { name: `Choose version ${digest}` }));
    await user.click(await screen.findByRole('button', { name: 'Inspect app Live notes' }));
    await user.click(await screen.findByRole('button', { name: `Restore snapshot ${snapshotId}` }));
    expect(
      screen.getByText(/All data changes after this snapshot will be discarded/)
    ).toBeInTheDocument();
    expect(restore).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: `Choose version ${earlier}` }));
    expect(
      screen.queryByRole('button', { name: 'Confirm restore and discard later data' })
    ).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Inspect app Live notes' }));
    await user.click(await screen.findByRole('button', { name: `Restore snapshot ${snapshotId}` }));
    await user.click(
      screen.getByRole('button', { name: 'Confirm restore and discard later data' })
    );
    await waitFor(() =>
      expect(restore).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId, appId, snapshotId, expectedAppRevision: 8 })
      )
    );
  });
});
