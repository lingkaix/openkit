import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { MAX_ARTIFACT_FILE_BYTES, type TurnFileInput } from '@openkit/protocol';
import { sha256ArtifactFile } from '../artifacts/file-digest';
import type { ConversationDraft } from './data';

// File objects are immutable browser selections. Retain their verified identity across an uncertain request without reopening a changed or unreadable backing file.
const inventories = new WeakMap<File, Promise<TurnFileInput>>();

/** Validates a local selection without a server upload, draft record, or Artifact effect. */
export function assertDraftFiles(files: readonly File[]): void {
  if (
    files.length > 10_000 ||
    files.reduce((total, file) => total + file.size, 0) > MAX_ARTIFACT_FILE_BYTES
  )
    throw new Error('Selected files exceed the combined 1,000,000,000-byte limit.');
}

/** Sends the same command identity through JSON reconciliation before opening original bytes. */
export async function submitConversationDraft(
  client: CoreClient,
  workspaceId: string,
  threadId: string,
  draft: ConversationDraft
) {
  const { files = [], ...command } = draft;
  assertDraftFiles(files);
  const fileInputs: TurnFileInput[] = [];
  for (const file of files) {
    let inventory = inventories.get(file);
    if (!inventory) {
      inventory = sha256ArtifactFile(file).then((contentDigest) => ({
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        contentDigest,
      }));
      inventories.set(file, inventory);
      void inventory.catch(() => inventories.delete(file));
    }
    fileInputs.push(await inventory);
  }
  const input = { workspaceId, threadId, ...command, ...(fileInputs.length ? { fileInputs } : {}) };
  try {
    return await client.operations['conversation.submit'](input);
  } catch (error) {
    if (
      !fileInputs.length ||
      !(error instanceof ApiCallError) ||
      error.code !== 'file_input_bytes_required'
    )
      throw error;
  }
  return client.conversationFiles.submit(input, files);
}
