import { allocateEntityId } from '@openkit/protocol';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { Composer, type ComposerWorkerEnvironmentOption } from './Composer';

const catalog = {
  workspaceId: allocateEntityId('ws'),
  threadId: null,
  defaultTargetRef: 'new-task-worker',
  targets: [
    {
      targetRef: 'new-task-worker',
      kind: 'new-task-worker' as const,
      label: 'New Task',
      description: null,
      availability: 'available' as const,
      unavailableReason: null,
      threadId: null,
      profileId: null,
      logicalModels: [],
      defaultLogicalModelId: null,
      requiresFileHandoffConfirmation: false,
    },
  ],
};

const sandbox: ComposerWorkerEnvironmentOption = {
  createdAt: '2026-11-07T00:00:00.000Z',
  expectedRevision: 1,
  layoutDigest: 'sha256:abc',
  lineage: 'Fresh work',
  occupancy: 'Empty',
  purpose: 'work',
  sourceLabel: 'Sandbox A',
  storageRef: 'st_1',
};

it('announces why sending is held', () => {
  render(<Composer targetCatalog={catalog} holdSubmit="Checking the Assistant." />);
  expect(screen.getByRole('status')).toHaveTextContent('Checking the Assistant.');
});

it('announces a sandbox inventory failure', async () => {
  const user = userEvent.setup();
  render(
    <Composer
      targetCatalog={catalog}
      workerEnvironments={{ items: [], onBrowse: vi.fn(), status: 'error' }}
    />
  );
  await user.click(screen.getByRole('button', { name: 'Add artifact or upload attachment' }));
  await user.click(screen.getByText('Advanced settings'));
  expect(screen.getByRole('status')).toHaveTextContent("Couldn't load Sandboxes.");
});

it('announces sandbox access denial', async () => {
  const user = userEvent.setup();
  render(
    <Composer
      targetCatalog={catalog}
      workerEnvironments={{ items: [], onBrowse: vi.fn(), status: 'denied' }}
    />
  );
  await user.click(screen.getByRole('button', { name: 'Add artifact or upload attachment' }));
  await user.click(screen.getByText('Advanced settings'));
  expect(screen.getByRole('status')).toHaveTextContent('Access denied');
});

it('announces a sandbox admission check', async () => {
  const user = userEvent.setup();
  render(
    <Composer
      targetCatalog={catalog}
      initialDraft={{
        input: '',
        targetRef: 'new-task-worker',
        artifactRefs: [],
        requestId: 'req-1',
        workerStorageChoice: {
          expectedRevision: 1,
          kind: 'selected',
          purpose: 'work',
          storageRef: 'st_1',
        },
      }}
      workerEnvironments={{
        items: [sandbox],
        onBrowse: vi.fn(),
        status: 'ready',
        threadId: 'th_1',
        selectionCheck: {
          message: 'Sandbox is admitted.',
          status: 'admitted',
          storageRef: 'st_1',
        },
      }}
    />
  );
  await user.click(screen.getByRole('button', { name: 'Add artifact or upload attachment' }));
  await user.click(screen.getByText('Advanced settings'));
  expect(screen.getByRole('status')).toHaveTextContent('Sandbox is admitted.');
});
