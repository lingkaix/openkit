import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { Artifact } from '../lib/app-types';
import { ArtifactView } from './ArtifactView';

const baseArtifact = {
  id: 'ar_demo',
  workspaceId: 'ws_demo',
  threadId: 'th_demo',
  turnId: 'tu_demo',
  title: 'Artifact title',
  status: 'ready' as const,
  summary: 'Artifact summary',
  version: 1,
  createdAt: '2026-04-15T09:00:00.000Z',
  updatedAt: '2026-04-15T09:00:00.000Z',
};

afterEach(() => {
  cleanup();
});

describe('ArtifactView', () => {
  it('renders text content', () => {
    const artifact: Artifact = {
      ...baseArtifact,
      kind: 'summary',
      content: { format: 'text', body: 'Plain text artifact body.' },
    };

    render(() => <ArtifactView artifact={artifact} onBack={() => undefined} />);

    expect(screen.getByRole('heading', { name: /artifact title/i })).toBeInTheDocument();
    expect(screen.getByText(/plain text artifact body/i)).toBeInTheDocument();
  });

  it('renders formatted JSON content', () => {
    const artifact: Artifact = {
      ...baseArtifact,
      kind: 'report',
      content: { format: 'json', body: '{"ok":true,"items":[1,2]}' },
    };

    render(() => <ArtifactView artifact={artifact} onBack={() => undefined} />);

    expect(screen.getByText(/"ok": true/i)).toBeInTheDocument();
    expect(screen.getByText(/"items":/i)).toBeInTheDocument();
  });

  it('renders diff artifacts as preformatted content', () => {
    const artifact: Artifact = {
      ...baseArtifact,
      kind: 'diff',
      content: { format: 'text', body: '- old line\n+ new line' },
    };

    render(() => <ArtifactView artifact={artifact} onBack={() => undefined} />);

    expect(screen.getByText(/- old line/i)).toBeInTheDocument();
    expect(screen.getByText(/\+ new line/i)).toBeInTheDocument();
  });
});
