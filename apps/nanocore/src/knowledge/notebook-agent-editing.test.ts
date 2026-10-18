import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { KnowledgeNotebook } from './notebook.js';
import { createNotebookAgentEditing } from './notebook-agent-editing.js';

/** One immutable base supplies selected files; omitted members never enter the virtual tree. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'notebook-agent-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const notebook = new KnowledgeNotebook({ repositoryPath: join(root, 'notebook.git') });
  const baseRevision = notebook.initialize({
    files: { 'omitted.md': 'Unadmitted bytes.' },
    metadata: {
      summary: 'Create',
      changeRequest: { requestId: randomUUID(), inputDigest: commandInputHash('create') },
      producer: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      authority: { kind: 'direct', instructionReference: 'fixture' },
      sourceReferences: [],
    },
  });
  const files = notebook.readRevision(baseRevision, ['index.md']).files;
  const submit = vi.fn(async (_edit: unknown) => ({
    outcome: 'review_required',
    proposalId: 'retained-proposal',
    baseRevision,
    candidateRevision: 'retained-candidate',
  }));
  const revalidate = vi.fn();
  const editor = createNotebookAgentEditing({
    notebook,
    baseRevision,
    requestId: randomUUID(),
    files,
    sources: { 'admitted.txt': 'Selected source.' },
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 20_000,
    revalidate,
    submit,
  });
  return { notebook, baseRevision, submit, editor, revalidate };
}

describe('bounded notebook Agent editing', () => {
  it('edits only admitted virtual data, retains failed-script edits and submits exact fixed-base changes once', async () => {
    const f = fixture();
    expect((await f.editor.workspaceUpdate({ script: 'cat /sources/admitted.txt' })).stdout).toBe(
      'Selected source.'
    );
    await expect(
      f.editor.workspaceUpdate({ script: 'echo changed > /sources/admitted.txt' })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      f.editor.workspaceUpdate({ script: 'echo changed > /notebook/omitted.md' })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(
      (await f.editor.workspaceUpdate({ script: 'cat /notebook/omitted.md' })).exitCode
    ).not.toBe(0);
    expect(
      (await f.editor.workspaceUpdate({ script: 'ln -s /sources/admitted.txt /notebook/link.md' }))
        .exitCode
    ).not.toBe(0);
    expect((await f.editor.workspaceUpdate({ script: 'node -e "1"' })).exitCode).not.toBe(0);
    expect(
      (await f.editor.workspaceUpdate({ script: 'curl https://example.com' })).exitCode
    ).not.toBe(0);
    expect(
      (await f.editor.workspaceUpdate({ script: 'printf "Draft bytes.\\n" > new.md; false' }))
        .exitCode
    ).not.toBe(0);
    expect(f.notebook.publishedRevision()).toBe(f.baseRevision);
    expect((await f.editor.workspaceUpdate({ script: 'cat new.md' })).stdout).toBe(
      'Draft bytes.\n'
    );
    expect(await f.editor.notebookUpdate({ summary: 'Save candidate' })).toMatchObject({
      outcome: 'review_required',
    });
    expect(f.submit).toHaveBeenCalledExactlyOnceWith({
      requestId: expect.any(String),
      baseRevision: f.baseRevision,
      summary: 'Save candidate',
      changes: [{ path: 'new.md', content: 'Draft bytes.\n' }],
    });
    expect(f.notebook.publishedRevision()).toBe(f.baseRevision);
    await expect(f.editor.workspaceUpdate({ script: 'echo later > new.md' })).rejects.toMatchObject(
      { code: 'invalid_request' }
    );
  });
});
