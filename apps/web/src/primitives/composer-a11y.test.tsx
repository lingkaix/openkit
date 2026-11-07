import { allocateEntityId } from '@openkit/protocol';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
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
      requiresFileHandoffConfirmation: false,
    },
  ],
};

it('names the hidden file input and keeps it out of the tab order', async () => {
  const user = userEvent.setup();
  render(<Composer targetCatalog={catalog} />);
  await user.click(screen.getByRole('button', { name: 'Add artifact or upload attachment' }));
  const input = screen.getByLabelText('Attach files');
  expect(input).toHaveAttribute('tabindex', '-1');
  await user.tab();
  expect(input).not.toHaveFocus();
  expect(screen.getByRole('button', { name: 'Attach files' })).toHaveFocus();
});

it('exposes whether an artifact attachment is selected', async () => {
  const user = userEvent.setup();
  render(
    <Composer
      targetCatalog={catalog}
      artifacts={[{ id: 'art_pricing', version: 2, label: 'Pricing sheet' }]}
    />
  );
  await user.click(screen.getByRole('button', { name: 'Add artifact or upload attachment' }));
  const artifact = screen.getByRole('button', { name: 'Pricing sheet', pressed: false });
  await user.click(artifact);
  expect(screen.getByRole('button', { name: 'Pricing sheet', pressed: true })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Pricing sheet', pressed: true }));
  expect(screen.getByRole('button', { name: 'Pricing sheet', pressed: false })).toBeInTheDocument();
});
