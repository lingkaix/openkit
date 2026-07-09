import type { WorkerLineage } from '@openkit/worker-protocol';
import { describe, expect, it } from 'vitest';
import { WorkerCapabilityClient, type WorkerCapabilityFetch } from './capability-client.js';

const lineage: WorkerLineage = {
  agentSessionId: 'as_capability_1',
  packageSnapshotId: 'pkg_snapshot_1',
  requestId: 'req_capability_1',
  threadId: 'th_demo',
  turnId: 'turn_demo',
  workspaceId: 'ws_demo',
};

/**
 * Creates a fake fetch implementation that records requests and returns queued responses.
 *
 * @param responses Responses returned for successive calls.
 * @returns Fake fetch function and captured requests.
 */
function createFetchFixture(responses: Array<{ body: unknown; ok?: boolean; status?: number }>): {
  fetch: WorkerCapabilityFetch;
  requests: Array<{ body: unknown; headers: Record<string, string>; url: string }>;
} {
  const requests: Array<{ body: unknown; headers: Record<string, string>; url: string }> = [];
  const fetch: WorkerCapabilityFetch = async (url, init) => {
    requests.push({
      body: JSON.parse(String(init?.body ?? '{}')) as unknown,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ])
      ),
      url,
    });
    const response = responses.shift() ?? { body: {}, ok: true, status: 200 };

    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => JSON.stringify(response.body),
    };
  };

  return { fetch, requests };
}

describe('WorkerCapabilityClient', () => {
  it('sends knowledge search and read calls with sandbox bearer lineage', async () => {
    const { fetch, requests } = createFetchFixture([
      { body: { capabilityCall: { family: 'knowledge.search' }, items: [] } },
      { body: { capabilityCall: { family: 'knowledge.read' }, item: { id: 'knowledge_1' } } },
    ]);
    const client = new WorkerCapabilityClient({
      baseUrl: 'https://capability.local/v1',
      fetch,
      lineage,
      token: 'token_capability_1',
    });

    await client.searchKnowledge({ limit: 5, query: 'OpenShell' });
    await client.readKnowledge({ knowledgeEntryId: 'knowledge_1' });

    expect(requests).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({ lineage, limit: 5, query: 'OpenShell' }),
        headers: expect.objectContaining({ authorization: 'Bearer token_capability_1' }),
        url: 'https://capability.local/v1/knowledge/search',
      }),
      expect.objectContaining({
        body: expect.objectContaining({ lineage, knowledgeEntryId: 'knowledge_1' }),
        headers: expect.objectContaining({ authorization: 'Bearer token_capability_1' }),
        url: 'https://capability.local/v1/knowledge/read',
      }),
    ]);
  });

  it('sends artifact read calls with sandbox bearer lineage', async () => {
    const { fetch, requests } = createFetchFixture([
      { body: { artifact: { id: 'artifact_1' }, capabilityCall: { family: 'artifact.read' } } },
    ]);
    const client = new WorkerCapabilityClient({
      baseUrl: 'https://capability.local/v1',
      fetch,
      lineage,
      token: 'token_capability_1',
    });

    await client.readArtifact({ artifactId: 'artifact_1' });

    expect(requests).toEqual([
      expect.objectContaining({
        body: { artifactId: 'artifact_1', lineage },
        headers: expect.objectContaining({ authorization: 'Bearer token_capability_1' }),
        url: 'https://capability.local/v1/artifacts/read',
      }),
    ]);
  });

  it('sends knowledge proposal calls with sandbox bearer lineage', async () => {
    const { fetch, requests } = createFetchFixture([
      { body: { capabilityCall: { family: 'knowledge.proposal' }, draft: { proposal: {} } } },
    ]);
    const client = new WorkerCapabilityClient({
      baseUrl: 'https://capability.local/v1',
      fetch,
      lineage,
      token: 'token_capability_1',
    });

    await client.proposeKnowledge({
      confidence: 0.7,
      sourceReferences: ['knowledge:entry_1'],
      summary: 'Remember the worker proposal path.',
      title: 'Worker proposal path',
    });

    expect(requests).toEqual([
      expect.objectContaining({
        body: {
          confidence: 0.7,
          lineage,
          sourceReferences: ['knowledge:entry_1'],
          summary: 'Remember the worker proposal path.',
          title: 'Worker proposal path',
        },
        headers: expect.objectContaining({ authorization: 'Bearer token_capability_1' }),
        url: 'https://capability.local/v1/knowledge/proposals',
      }),
    ]);
  });

  it('sends MCP list calls with sandbox bearer lineage', async () => {
    const { fetch, requests } = createFetchFixture([
      { body: { capabilityCall: { family: 'worker_mcp.call' }, servers: [] } },
      {
        body: {
          capabilityCall: { family: 'worker_mcp.call' },
          schemaSnapshotId: 'mcpsnap_github_sha256-github-mcp-v1',
          tools: [],
        },
      },
    ]);
    const client = new WorkerCapabilityClient({
      baseUrl: 'https://capability.local/v1/',
      fetch,
      lineage,
      token: 'token_capability_1',
    });

    await client.listMcpServers();
    await client.listMcpTools({ serverId: 'github' });

    expect(requests).toEqual([
      expect.objectContaining({
        body: { lineage },
        headers: expect.objectContaining({ authorization: 'Bearer token_capability_1' }),
        url: 'https://capability.local/v1/mcp/list-servers',
      }),
      expect.objectContaining({
        body: { lineage, serverId: 'github' },
        headers: expect.objectContaining({ authorization: 'Bearer token_capability_1' }),
        url: 'https://capability.local/v1/mcp/list-tools',
      }),
    ]);
  });

  it('sends MCP tool calls with sandbox bearer lineage', async () => {
    const { fetch, requests } = createFetchFixture([
      {
        body: {
          capabilityCall: { family: 'worker_mcp.call' },
          result: { ok: true },
          schemaSnapshotId: 'mcpsnap_github_sha256-github-mcp-v1',
        },
      },
      {
        body: {
          capabilityCall: { family: 'worker_mcp.call' },
          result: { ok: true },
          schemaSnapshotId: 'mcpsnap_github_sha256-github-mcp-v1',
        },
      },
    ]);
    const client = new WorkerCapabilityClient({
      baseUrl: 'https://capability.local/v1/',
      fetch,
      lineage,
      token: 'token_capability_1',
    });

    await client.callMcpTool({
      arguments: { owner: 'openkit', repo: 'openkit' },
      policyDecisionId: 'pd_mcp_call_1',
      serverId: 'github',
      toolName: 'repos.get',
    });
    await client.callMcpTool({
      approvalRequestId: 'ap_mcp_approval_1',
      arguments: { owner: 'openkit', repo: 'openkit' },
      serverId: 'github',
      toolName: 'issues.list',
    });

    expect(requests).toEqual([
      expect.objectContaining({
        body: {
          arguments: { owner: 'openkit', repo: 'openkit' },
          lineage,
          policyDecisionId: 'pd_mcp_call_1',
          serverId: 'github',
          toolName: 'repos.get',
        },
        headers: expect.objectContaining({ authorization: 'Bearer token_capability_1' }),
        url: 'https://capability.local/v1/mcp/call-tool',
      }),
      expect.objectContaining({
        body: {
          approvalRequestId: 'ap_mcp_approval_1',
          arguments: { owner: 'openkit', repo: 'openkit' },
          lineage,
          serverId: 'github',
          toolName: 'issues.list',
        },
        headers: expect.objectContaining({ authorization: 'Bearer token_capability_1' }),
        url: 'https://capability.local/v1/mcp/call-tool',
      }),
    ]);
  });

  it('sends diagnostic read calls with sandbox bearer lineage', async () => {
    const { fetch, requests } = createFetchFixture([
      { body: { capabilityCall: { family: 'diagnostic.read' }, diagnostics: {} } },
    ]);
    const client = new WorkerCapabilityClient({
      baseUrl: 'https://capability.local/v1/',
      fetch,
      lineage,
      token: 'token_capability_1',
    });

    await client.readDiagnostics();

    expect(requests).toEqual([
      expect.objectContaining({
        body: { lineage },
        headers: expect.objectContaining({ authorization: 'Bearer token_capability_1' }),
        url: 'https://capability.local/v1/diagnostics/read',
      }),
    ]);
  });

  it('raises product-safe errors for rejected capability calls', async () => {
    const { fetch } = createFetchFixture([
      {
        body: { code: 'worker_control_unauthorized', message: 'Token rejected.' },
        ok: false,
        status: 401,
      },
    ]);
    const client = new WorkerCapabilityClient({
      baseUrl: 'https://capability.local/v1',
      fetch,
      lineage,
      token: 'bad',
    });

    await expect(client.searchKnowledge({ query: 'OpenShell' })).rejects.toThrowError(
      'Worker capability request failed: worker_control_unauthorized'
    );
  });
});
