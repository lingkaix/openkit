import { allocateEntityId } from '@openkit/protocol';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { Composer } from './Composer';

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
      requiresFileHandoffConfirmation: true,
    },
  ],
};

it('restores focus to the message field when file handoff is cancelled', async () => {
  const user = userEvent.setup();
  const file = new File(['exact'], 'local.txt', { type: 'text/plain' });
  render(
    <Composer targetCatalog={catalog} fileWorkspaceLabel="Receiving Workspace" onSubmit={vi.fn()} />
  );
  const message = screen.getByRole('textbox', { name: 'Message' });
  await user.type(message, 'First brief');
  await user.click(screen.getByRole('button', { name: 'Add artifact or upload attachment' }));
  await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);
  await user.click(screen.getByRole('button', { name: 'Send message' }));
  await user.click(
    within(screen.getByRole('dialog', { name: 'Share selected files with Worker' })).getByRole(
      'button',
      { name: 'Cancel' }
    )
  );
  expect(message).toHaveFocus();
  expect(message).toBeEnabled();
});
