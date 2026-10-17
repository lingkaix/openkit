import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createConversationFileClient } from './conversation-files.js';
import type { ClientTransport } from './transport.js';

const workspaceId = allocateEntityId('ws');
const threadId = allocateEntityId('th');

describe('conversation original transport', () => {
  it('frames ordered arbitrary bytes and empty parts without reading the original Blobs', async () => {
    const postStream = vi.fn().mockResolvedValue({});
    const client = createConversationFileClient({ postStream } as unknown as ClientTransport);
    const files = [new Blob([]), new Blob([new Uint8Array([0, 0xff, 0xc0, 0x80])])];
    for (const file of files)
      vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('Original read is forbidden.'));
    const input = {
      workspaceId: workspaceId,
      threadId: threadId,
      input: '',
      requestId: 'same-request',
      targetRef: 'internal-role:assistant',
      artifactRefs: [],
      fileInputs: files.map((file) => ({
        name: '../not-a-path',
        mediaType: 'application/octet-stream',
        sizeBytes: file.size,
        contentDigest: `sha256:${'a'.repeat(64)}`,
      })),
    };
    await client.submit(input, files);
    const [path, body, headers] = postStream.mock.calls[0]!;
    expect(path).toBe('/api/app/operations/conversation.submit');
    expect(headers).toEqual({
      'content-type': 'application/vnd.openkit.conversation-files',
      'x-openkit-request-id': 'same-request',
    });
    const bytes = new Uint8Array(await (body as Blob).arrayBuffer());
    const length = new DataView(bytes.buffer).getUint32(0, false);
    expect(JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)))).toEqual(input);
    expect(bytes.subarray(4 + length)).toEqual(new Uint8Array([0, 0xff, 0xc0, 0x80]));
    for (const file of files) expect(file.arrayBuffer).not.toHaveBeenCalled();
  });

  it('refuses false length and missing parts before transfer', () => {
    const postStream = vi.fn();
    const client = createConversationFileClient({ postStream } as unknown as ClientTransport);
    const input = {
      workspaceId: workspaceId,
      threadId: threadId,
      input: '',
      requestId: 'same-request',
      targetRef: 'internal-role:assistant',
      artifactRefs: [],
      fileInputs: [
        {
          name: 'input',
          mediaType: 'text/plain',
          sizeBytes: 2,
          contentDigest: `sha256:${'a'.repeat(64)}`,
        },
      ],
    };
    expect(() => client.submit(input, [])).toThrow('inventory');
    expect(() => client.submit(input, [new Blob(['a'])])).toThrow('inventory');
    expect(postStream).not.toHaveBeenCalled();
  });
});
