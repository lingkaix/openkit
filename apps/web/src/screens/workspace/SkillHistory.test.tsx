import type { CoreClient } from '@openkit/core-client';
import { allocateEntityId } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { SkillHistory } from './SkillHistory';

const workspaceId = allocateEntityId('ws');
const digest = `sha256:${'a'.repeat(64)}`;
const olderDigest = `sha256:${'b'.repeat(64)}`;
const version = {
  digest,
  entryId: 'research',
  contentState: 'retained',
  createdAt: '2026-10-16T10:00:00Z',
  provenance: {
    sourceLocator: 'owner/repo',
    sourceCommit: '1234',
    sourceSubpath: 'skills/research',
  },
  inventory: [{ kind: 'file', path: 'SKILL.md', executable: false, size: 5 }],
};

function fixture(
  blocked = false,
  failVersionRead = false,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  const operations = {
    'catalog.skill-version-list': vi
      .fn()
      .mockResolvedValue({ items: [version, { ...version, digest: olderDigest }] }),
    'catalog.skill-version-read': failVersionRead
      ? vi.fn().mockRejectedValue(new Error('read refused'))
      : vi.fn().mockResolvedValue({ version }),
    'catalog.skill-content-read': vi
      .fn()
      .mockResolvedValue({ digest, path: 'SKILL.md', contentBase64: btoa('hello') }),
    'catalog.skill-diff': vi
      .fn()
      .mockResolvedValue({ changes: [{ path: 'SKILL.md', before: {}, after: {} }] }),
    'catalog.skill-update-check': vi.fn().mockResolvedValue({ status: 'unchanged' }),
    'catalog.skill-remove': vi.fn().mockResolvedValue({ revision: 8 }),
    'catalog.skill-purge': vi.fn().mockResolvedValue({ revision: 8 }),
  };
  const client = { operations } as unknown as CoreClient;
  render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <SkillHistory workspaceId={workspaceId} skillId="research" revision={7} blocked={blocked} />
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return operations;
}

describe('Skill retained history', () => {
  it('reads exact retained provenance and bytes, checks updates and compares versions before explicit removal', async () => {
    const user = userEvent.setup();
    const operations = fixture();
    await user.click(await screen.findByRole('button', { name: /Inspect sha256:aaaa/ }));
    expect(await screen.findByText('owner/repo')).toBeInTheDocument();
    expect(operations['catalog.skill-version-read']).toHaveBeenCalledWith({
      workspaceId,
      skillId: 'research',
      digest,
    });
    await user.click(screen.getByRole('button', { name: 'Read SKILL.md' }));
    expect(await screen.findByText('hello')).toBeInTheDocument();
    expect(operations['catalog.skill-content-read']).toHaveBeenCalledWith({
      workspaceId,
      skillId: 'research',
      digest,
      path: 'SKILL.md',
    });
    await user.click(screen.getByRole('button', { name: 'Check source for updates' }));
    expect(await screen.findByText('Source check: unchanged')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Compare with sha256:bbbb/ }));
    expect(await screen.findByText('Changed: SKILL.md')).toBeInTheDocument();
    expect(operations['catalog.skill-diff']).toHaveBeenCalledWith({
      workspaceId,
      skillId: 'research',
      baseDigest: digest,
      candidateDigest: olderDigest,
    });
    await user.click(screen.getByRole('button', { name: 'Remove Skill from future selection' }));
    await waitFor(() =>
      expect(operations['catalog.skill-remove']).toHaveBeenCalledWith({
        workspaceId,
        skillId: 'research',
        expectedRevision: 7,
        requestId: expect.any(String),
      })
    );
    await user.click(screen.getByRole('button', { name: 'Delete retained version bytes' }));
    expect(operations['catalog.skill-purge']).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm permanent deletion' }));
    await waitFor(() =>
      expect(operations['catalog.skill-purge']).toHaveBeenCalledWith({
        workspaceId,
        skillId: 'research',
        digest,
        expectedRevision: 7,
        requestId: expect.any(String),
      })
    );
    await waitFor(() => expect(screen.queryByText('hello')).not.toBeInTheDocument());
  });

  it('reports an exact version read failure with an explicit retry', async () => {
    const user = userEvent.setup();
    const operations = fixture(false, true);
    await user.click(await screen.findByRole('button', { name: /Inspect sha256:aaaa/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't read that Skill version.");
    operations['catalog.skill-version-read'].mockResolvedValue({ version });
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('owner/repo')).toBeInTheDocument();
    expect(operations['catalog.skill-version-read']).toHaveBeenCalledTimes(2);
  });

  it.each(['history', 'version', 'content', 'diff'] as const)(
    'hides retained %s data after the current read is refused',
    async (read) => {
      const user = userEvent.setup();
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const operations = fixture(false, false, queryClient);
      await user.click(await screen.findByRole('button', { name: /Inspect sha256:aaaa/ }));
      await user.click(await screen.findByRole('button', { name: 'Read SKILL.md' }));
      expect(await screen.findByText('hello')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Compare with sha256:bbbb/ }));
      expect(await screen.findByText('Changed: SKILL.md')).toBeInTheDocument();
      const operation = {
        history: 'catalog.skill-version-list',
        version: 'catalog.skill-version-read',
        content: 'catalog.skill-content-read',
        diff: 'catalog.skill-diff',
      } as const;
      const keys = {
        history: ['skill-history', workspaceId, 'research'],
        version: ['skill-version', workspaceId, 'research', digest],
        content: ['skill-content', workspaceId, 'research', digest, 'SKILL.md'],
        diff: ['skill-diff', workspaceId, 'research', digest, olderDigest],
      };
      operations[operation[read]].mockRejectedValue(new Error('current read refused'));
      await act(async () => {
        await queryClient.refetchQueries({ queryKey: keys[read], exact: true });
      });
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      if (read !== 'diff') {
        expect(screen.queryByText('hello')).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Download exact file bytes' })).not.toBeInTheDocument();
      }
      if (read !== 'content') expect(screen.queryByText('Changed: SKILL.md')).not.toBeInTheDocument();
      if (read === 'history' || read === 'version')
        expect(screen.queryByText('owner/repo')).not.toBeInTheDocument();
    }
  );

  it('disables retained operations while disconnected', async () => {
    const operations = fixture(true);
    await screen.findByRole('button', { name: /Inspect sha256:aaaa/ });
    expect(screen.getByRole('button', { name: /Inspect sha256:aaaa/ })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Remove Skill from future selection' })
    ).toBeDisabled();
    expect(operations['catalog.skill-version-read']).not.toHaveBeenCalled();
  });
});
