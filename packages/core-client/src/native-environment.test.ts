import { describe, expect, it, vi } from 'vitest';
import { createRuntimeConfigClient } from './runtime-config.js';
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
    const client = createRuntimeConfigClient(
      createClientTransport({ baseUrl: 'http://127.0.0.1:9', fetch })
    );
    expect(await client.getAgentNativeEnvironment(view.fileId)).toEqual({
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

  it('uses encoded private administration GET and exact typed CAS PUT', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(view), { headers: { 'content-type': 'application/json' } })
    );
    const client = createRuntimeConfigClient(
      createClientTransport({ baseUrl: 'http://127.0.0.1:9', fetch })
    );
    expect(await client.getAgentNativeEnvironment(view.fileId)).toEqual(view);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:9/api/admin/config/agent-environment?fileId=agents%2Fa%20b.agent.jsonc'
    );
    const request = {
      fileId: view.fileId,
      expectedRevision: digest,
      imageDigest: digest,
      defaultsDigest: digest,
      environment: { A: null, EMPTY: '' },
    };
    await client.updateAgentNativeEnvironment(request);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: 'PUT',
      body: JSON.stringify(request),
      credentials: 'include',
    });
    expect(() =>
      client.updateAgentNativeEnvironment({ ...request, environment: { 'BAD-NAME': 'x' } })
    ).toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
