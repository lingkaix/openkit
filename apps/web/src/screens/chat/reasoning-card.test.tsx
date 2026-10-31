import { allocateEntityId, ItemSchema } from '@openkit/protocol';
import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ItemView } from './ItemView';

function reasoningItem(summary: string[], content: string[]) {
  return ItemSchema.parse({
    id: allocateEntityId('it'),
    owner: { kind: 'workspace', workspaceId: allocateEntityId('ws') },
    threadId: allocateEntityId('th'),
    turnId: allocateEntityId('tu'),
    type: 'reasoning',
    status: 'completed',
    createdAt: '2026-10-16T00:00:00.000Z',
    completedAt: '2026-10-16T00:00:00.000Z',
    summary,
    content,
  });
}

function cardMeta(container: HTMLElement): string {
  return container.querySelector('p.text-fg-muted')?.textContent ?? '';
}

/** Reads collapsed details text from each pre-wrapped region, in document order. */
function prewrappedText(details: HTMLElement): string {
  const regions = [...details.querySelectorAll('.whitespace-pre-wrap')].filter(
    (node) => node.querySelector('.whitespace-pre-wrap') === null
  );
  if (regions.length === 0 && details.classList.contains('whitespace-pre-wrap')) {
    regions.push(details);
  }
  expect(regions.length).toBeGreaterThan(0);
  return regions.map((node) => node.textContent ?? '').join('\n');
}

function expectCollapsedParts(details: Element | null, parts: readonly string[]) {
  expect(details).not.toBeNull();
  expect((details as HTMLDetailsElement).open).toBe(false);
  const text = prewrappedText(details as HTMLElement);
  let cursor = -1;
  for (const part of parts) {
    const index = text.indexOf(part);
    expect(index).toBeGreaterThan(cursor);
    cursor = index;
  }
}

it('renders one summary part as meta and no details element', () => {
  const { container } = render(<ItemView item={reasoningItem(['Only the first line'], [])} />);
  expect(cardMeta(container)).toBe('Only the first line');
  expect(container.querySelector('details')).toBeNull();
});

it('renders three summary parts in order inside a collapsed details element', () => {
  const parts = ['Alpha line', 'Beta line', 'Gamma line'] as const;
  const { container } = render(<ItemView item={reasoningItem([...parts], [])} />);
  expect(cardMeta(container)).toBe('Alpha line');
  expectCollapsedParts(container.querySelector('details'), parts);
});

it('renders readable content parts inside the collapsed details element', () => {
  const { container } = render(
    <ItemView
      item={reasoningItem(['Lead summary'], ['First readable part', 'Second readable part'])}
    />
  );
  expect(cardMeta(container)).toBe('Lead summary');
  expectCollapsedParts(container.querySelector('details'), [
    'First readable part',
    'Second readable part',
  ]);
});

it('keeps the fallback meta text when the summary is empty', () => {
  const { container } = render(<ItemView item={reasoningItem([], [])} />);
  expect(cardMeta(container)).toBe('Thinking through the task');
  expect(container.querySelector('details')).toBeNull();
});
