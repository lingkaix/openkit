import { allocateEntityId, ItemSchema } from '@openkit/protocol';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ItemView } from './ItemView';

function reasoningItem(overrides: { summary?: string[]; content?: string[] }) {
  return ItemSchema.parse({
    id: allocateEntityId('it'),
    owner: { kind: 'workspace', workspaceId: allocateEntityId('ws') },
    threadId: allocateEntityId('th'),
    turnId: allocateEntityId('tu'),
    type: 'reasoning',
    status: 'completed',
    createdAt: '2026-10-31T00:00:00.000Z',
    completedAt: '2026-10-31T00:00:01.000Z',
    summary: overrides.summary ?? [],
    content: overrides.content ?? [],
  });
}

it('shows a single summary line as meta without a details element', () => {
  const { container } = render(
    <ItemView item={reasoningItem({ summary: ['First summary line only'] })} />
  );
  expect(screen.getByText('First summary line only')).toBeInTheDocument();
  expect(container.querySelector('details')).toBeNull();
});

it('renders three summary parts in order inside details', () => {
  const { container } = render(
    <ItemView
      item={reasoningItem({
        summary: ['Summary one', 'Summary two', 'Summary three'],
      })}
    />
  );
  fireEvent.click(screen.getByText('Full reasoning'));
  const details = container.querySelector('details');
  expect(details).not.toBeNull();
  const parts = details!.querySelectorAll('p');
  expect([...parts].map((node) => node.textContent)).toEqual([
    'Summary one',
    'Summary two',
    'Summary three',
  ]);
});

it('renders readable content parts inside details', () => {
  render(
    <ItemView
      item={reasoningItem({
        summary: ['Collapsed meta'],
        content: ['Readable body alpha', 'Readable body beta'],
      })}
    />
  );
  fireEvent.click(screen.getByText('Full reasoning'));
  expect(screen.getByText('Readable body alpha')).toBeVisible();
  expect(screen.getByText('Readable body beta')).toBeVisible();
});

it('uses the fallback meta when summary is empty', () => {
  const { container } = render(<ItemView item={reasoningItem({ summary: [] })} />);
  expect(screen.getByText('Thinking through the task')).toBeInTheDocument();
  expect(container.querySelector('details')).toBeNull();
});
