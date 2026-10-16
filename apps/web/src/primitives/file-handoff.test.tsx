import { allocateEntityId } from '@openkit/protocol';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { Composer } from './Composer';

/** The catalog declares the actual shared destination; it is not inferred from an identifier format. */
const catalog = {
  workspaceId: allocateEntityId('ws'),
  threadId: null,
  defaultTargetRef: 'new-task-worker',
  targets: [
    {
      targetRef: 'new-task-worker',
      kind: 'new-task-worker' as const,
      label: 'New Shard + Worker',
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

it('presents the exact work brief, selected files and receiving Workspace before file disclosure', async () => {
  const user = userEvent.setup();
  const submit = vi.fn().mockResolvedValue(undefined);
  const brief = '  Exact public brief\nKeep this scope.  ';
  const file = new File([new Uint8Array([0xff, 0, 1])], 'selected.bin', {
    type: 'application/octet-stream',
  });
  render(
    <Composer targetCatalog={catalog} fileWorkspaceLabel="Receiving Workspace" onSubmit={submit} />
  );
  await user.type(screen.getByRole('textbox', { name: 'Message' }), brief);
  await user.click(screen.getByRole('button', { name: 'Add artifact or upload attachment' }));
  await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);
  await user.click(screen.getByRole('button', { name: 'Send message' }));
  const dialog = screen.getByRole('dialog', { name: 'Share selected files with Worker' });
  expect(within(dialog).getByText('Receiving Workspace', { exact: true })).toBeInTheDocument();
  expect(within(dialog).getByLabelText('Work brief').textContent).toBe(brief);
  expect(within(dialog).getByText('selected.bin', { exact: true })).toBeInTheDocument();
  expect(submit).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: 'Share files and send' }));
  expect(submit).toHaveBeenCalledOnce();
  const accepted = submit.mock.calls[0]![0];
  expect(accepted.input).toBe(brief);
  expect(accepted.files[0]).toBe(file);
  expect(accepted.fileHandoffConfirmed).toBe(true);
});

it('keeps unsent files after dismissing a handoff and does not reuse consent for an edited brief', async () => {
  const user = userEvent.setup();
  const submit = vi.fn().mockRejectedValue(new Error('Uncertain response.'));
  const file = new File(['exact'], 'local.txt', { type: 'text/plain' });
  render(
    <Composer targetCatalog={catalog} fileWorkspaceLabel="Receiving Workspace" onSubmit={submit} />
  );
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'First brief');
  await user.click(screen.getByRole('button', { name: 'Add artifact or upload attachment' }));
  await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);
  await user.click(screen.getByRole('button', { name: 'Send message' }));
  await user.click(
    within(screen.getByRole('dialog', { name: 'Share selected files with Worker' })).getByRole(
      'button',
      { name: 'Cancel' }
    )
  );
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Remove file local.txt' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Send message' }));
  await user.click(
    within(screen.getByRole('dialog', { name: 'Share selected files with Worker' })).getByRole(
      'button',
      { name: 'Share files and send' }
    )
  );
  expect(submit).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button', { name: 'Send message' }));
  expect(submit).toHaveBeenCalledTimes(2);
  expect(submit.mock.calls[1]![0]).toEqual(submit.mock.calls[0]![0]);
  await user.type(screen.getByRole('textbox', { name: 'Message' }), ' changed');
  await user.click(screen.getByRole('button', { name: 'Send message' }));
  expect(screen.getByRole('dialog', { name: 'Share selected files with Worker' })).toBeVisible();
  expect(submit).toHaveBeenCalledTimes(2);
});
