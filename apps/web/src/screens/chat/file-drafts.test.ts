import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { describe, expect, it, vi } from 'vitest';
import { sha256ArtifactFile } from '../artifacts/file-digest';
import type { ConversationDraft } from './data';
import { assertDraftFiles, submitConversationDraft } from './file-drafts';

vi.mock('../artifacts/file-digest', () => ({
  sha256ArtifactFile: vi.fn().mockResolvedValue(`sha256:${'a'.repeat(64)}`),
}));

describe('client file drafts', () => {
  it('reconciles an uncertain command using cached inventory without reading or uploading originals again', async () => {
    const file = new File([new Uint8Array([0xff, 0])], 'binary.bin', {
      type: 'application/octet-stream',
    });
    const draft: ConversationDraft = {
      input: '',
      targetRef: 'internal-role:assistant',
      requestId: 'retained-request',
      artifactRefs: [],
      files: [file],
    };
    const submit = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiCallError(400, 'Bytes required.', { code: 'file_input_bytes_required' })
      )
      .mockResolvedValueOnce({ accepted: true });
    const transfer = vi.fn().mockRejectedValueOnce(new Error('Acknowledgement lost.'));
    const client = {
      operations: { 'conversation.submit': submit },
      conversationFiles: { submit: transfer },
    } as unknown as CoreClient;
    await expect(submitConversationDraft(client, 'ws_test', 'th_test', draft)).rejects.toThrow(
      'Acknowledgement lost.'
    );
    const hashCalls = vi.mocked(sha256ArtifactFile).mock.calls.length;
    await expect(submitConversationDraft(client, 'ws_test', 'th_test', draft)).resolves.toEqual({
      accepted: true,
    });
    expect(sha256ArtifactFile).toHaveBeenCalledTimes(hashCalls);
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]);
    expect(submit.mock.calls[1]![0]).not.toHaveProperty('files');
    expect(draft.files).toEqual([file]);
    expect(draft.requestId).toBe('retained-request');
  });

  it('admits exactly the combined decimal limit and rejects one more byte before reading files', () => {
    const file = (size: number) => ({ size }) as File;
    expect(() => assertDraftFiles([file(999_999_999), file(1)])).not.toThrow();
    expect(() => assertDraftFiles([file(999_999_999), file(2)])).toThrow('1,000,000,000');
  });
});
