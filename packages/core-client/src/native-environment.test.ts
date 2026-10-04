import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { createOperationClient } from './operations.js';
import { createClientTransport } from './transport.js';

const digest = `sha256:${'a'.repeat(64)}`;
const view = {
  agentId: 'agent',
  fileId: 'agents/a b.agent.jsonc',
  persistedRevision: digest,
  defaults: { A: 'image' },
  overrides: { A: null },
  managedNames: [],
  desired: { imageDigest: digest, defaultsDigest: digest, values: {} },
  reload: { matchesDesired: false, snapshotVersion: 1 },
  applied: [],
  sharedAgentImpact: 'All later Turns using this Agent.',
};

describe('native environment configuration client', () => {
  it('strips inert metadata from private environment responses and nested identities', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...view,
            note: 'inert',
            desired: { ...view.desired, note: 'inert' },
            reload: { ...view.reload, note: 'inert' },
            applied: [
              {
                workspaceId: 'ws',
                threadId: 'thread',
                state: 'pending',
                environment: { ...view.desired, note: 'inert' },
                matchesDesired: true,
                note: 'inert',
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } }
        )
    );
    const client = createOperationClient(
      createClientTransport({ baseUrl: 'http://127.0.0.1:9', fetch })
    );
    expect(await client['runtime.agent-environment-read']({ fileId: view.fileId })).toEqual({
      ...view,
      applied: [
        {
          workspaceId: 'ws',
          threadId: 'thread',
          state: 'pending',
          environment: view.desired,
          matchesDesired: true,
        },
      ],
    });
  });

  it('uses canonical runtime environment operations and exact typed CAS input', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(view), { headers: { 'content-type': 'application/json' } })
    );
    const client = createOperationClient(
      createClientTransport({ baseUrl: 'http://127.0.0.1:9', fetch })
    );
    expect(await client['runtime.agent-environment-read']({ fileId: view.fileId })).toEqual(view);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:9/api/app/operations/runtime.agent-environment-read'
    );
    const request = {
      fileId: view.fileId,
      expectedRevision: digest,
      imageDigest: digest,
      defaultsDigest: digest,
      environment: { A: null, EMPTY: '' },
    };
    await client['runtime.agent-environment-update'](request);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(request),
      credentials: 'include',
    });
    await expect(
      client['runtime.agent-environment-update']({ ...request, environment: { 'BAD-NAME': 'x' } })
    ).rejects.toBeInstanceOf(ZodError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
