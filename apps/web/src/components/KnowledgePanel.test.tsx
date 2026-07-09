import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';

import type { KnowledgeEntry } from '../lib/app-types';
import { KnowledgePanel, type UpdateKnowledgeInput } from './KnowledgePanel';

const initialEntry: KnowledgeEntry = {
  id: 'kn_1',
  kind: 'project-context',
  title: 'Architecture notes',
  content: 'Keep protocol boundaries explicit.',
  createdAt: '2026-04-15T09:00:00.000Z',
  updatedAt: '2026-04-15T09:00:00.000Z',
};

afterEach(() => {
  cleanup();
});

describe('KnowledgePanel', () => {
  it('lists knowledge entries', () => {
    render(() => (
      <KnowledgePanel
        entries={[initialEntry]}
        errorMessage={null}
        isSaving={false}
        onCreate={async () => undefined}
        onDelete={async () => undefined}
        onUpdate={async () => undefined}
      />
    ));

    expect(screen.getByText(/architecture notes/i)).toBeInTheDocument();
    expect(screen.getByText(/keep protocol boundaries explicit/i)).toBeInTheDocument();
  });

  it('creates a knowledge entry', async () => {
    const [entries, setEntries] = createSignal<KnowledgeEntry[]>([]);

    render(() => (
      <KnowledgePanel
        entries={entries()}
        errorMessage={null}
        isSaving={false}
        onCreate={async (input) => {
          setEntries([
            ...entries(),
            {
              id: 'kn_2',
              ...input,
              createdAt: '2026-04-15T09:05:00.000Z',
              updatedAt: '2026-04-15T09:05:00.000Z',
            },
          ]);
        }}
        onDelete={async () => undefined}
        onUpdate={async () => undefined}
      />
    ));

    fireEvent.change(screen.getByLabelText(/knowledge kind/i), {
      target: { value: 'preference' },
    });
    fireEvent.input(screen.getByLabelText(/knowledge title/i), {
      target: { value: 'Model preference' },
    });
    fireEvent.input(screen.getByLabelText(/knowledge content/i), {
      target: { value: 'Use the fastest local model for drafts.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add knowledge/i }));

    expect(await screen.findByText(/model preference/i)).toBeInTheDocument();
    expect(screen.getByText(/use the fastest local model/i)).toBeInTheDocument();
  });

  it('shows optimistic edits, reverts on failure, and displays the error', async () => {
    const [entries, setEntries] = createSignal<KnowledgeEntry[]>([initialEntry]);
    const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
    let rejectUpdate: (error: Error) => void = () => undefined;
    const updatePromise = new Promise<never>((_, reject) => {
      rejectUpdate = reject;
    });

    render(() => (
      <KnowledgePanel
        entries={entries()}
        errorMessage={errorMessage()}
        isSaving={false}
        onCreate={async () => undefined}
        onDelete={async () => undefined}
        onUpdate={async (knowledgeEntryId, input: UpdateKnowledgeInput) => {
          const previousEntries = entries();
          setEntries(
            entries().map((entry) =>
              entry.id === knowledgeEntryId
                ? {
                    ...entry,
                    ...input,
                    updatedAt: '2026-04-15T09:10:00.000Z',
                  }
                : entry
            )
          );

          try {
            await updatePromise;
          } catch (error) {
            setEntries(previousEntries);
            setErrorMessage((error as Error).message);
            throw error;
          }
        }}
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: /edit architecture notes/i }));
    fireEvent.input(screen.getByLabelText(/knowledge title/i), {
      target: { value: 'Updated architecture notes' },
    });
    fireEvent.input(screen.getByLabelText(/knowledge content/i), {
      target: { value: 'Updated optimistic content.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save knowledge/i }));

    expect(await screen.findByText(/updated architecture notes/i)).toBeInTheDocument();

    rejectUpdate(new Error('Server rejected knowledge update.'));

    expect(await screen.findByText(/keep protocol boundaries explicit/i)).toBeInTheDocument();
    expect(screen.getByText(/server rejected knowledge update/i)).toBeInTheDocument();
  });

  it('deletes a knowledge entry', async () => {
    const [entries, setEntries] = createSignal<KnowledgeEntry[]>([initialEntry]);

    render(() => (
      <KnowledgePanel
        entries={entries()}
        errorMessage={null}
        isSaving={false}
        onCreate={async () => undefined}
        onDelete={async (knowledgeEntryId) => {
          setEntries(entries().filter((entry) => entry.id !== knowledgeEntryId));
        }}
        onUpdate={async () => undefined}
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: /delete architecture notes/i }));

    expect(await screen.findByText(/no knowledge entries yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/architecture notes/i)).not.toBeInTheDocument();
  });
});
