import { allocateEntityId, ItemSchema } from '@openkit/protocol';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ItemView } from './ItemView';

it('shows the continuation seen by the model and its inspectable exact history range', () => {
  const firstItemId = allocateEntityId('it');
  const lastItemId = allocateEntityId('it');
  const item = ItemSchema.parse({
    id: allocateEntityId('it'),
    workspaceId: allocateEntityId('ws'),
    threadId: allocateEntityId('th'),
    turnId: allocateEntityId('tu'),
    type: 'context-summary',
    strategy: 'rolling',
    logicalModelId: 'internal-role',
    status: 'completed',
    createdAt: '2026-10-16T00:00:00.000Z',
    completedAt: '2026-10-16T00:00:00.000Z',
    text: 'Keep the original deployment constraint.',
    environmentDigest: `sha256:${'1'.repeat(64)}`,
    sourceRange: {
      firstItemId,
      lastItemId,
      itemCount: 12,
      sourceDigest: `sha256:${'2'.repeat(64)}`,
      evidenceDigest: `sha256:${'3'.repeat(64)}`,
    },
  });
  render(<ItemView item={item} />);
  expect(screen.getByText('Continuation summary')).toBeInTheDocument();
  expect(screen.getByText('Keep the original deployment constraint.')).toBeInTheDocument();
  expect(screen.getByText(/Covers 12 earlier Items/)).toHaveTextContent(
    'Exact history remains available.'
  );
  fireEvent.click(screen.getByText('Covered history range'));
  expect(screen.getByText(`${firstItemId} through ${lastItemId}`)).toBeVisible();
});
