import { describe, expect, it } from 'vitest';
import { createJsonRpcHandler } from './mcp-protocol.js';
import type { OpenKitNanoCoreClient } from './nanocore-client.js';
import { createOpenKitAiInterface } from './registry.js';

/** Creates a minimal fake NanoCore facade for JSON-RPC adapter tests. */
function createFakeNanoCoreClient(): OpenKitNanoCoreClient {
  const respond = async (method: string, input: unknown): Promise<unknown> => ({
    goal: { goalId: 'goal_demo', status: 'running' },
    input,
    method,
  });

  return {
    approveGoalPlan: (input) => respond('approveGoalPlan', input),
    createEvidenceBundle: (input) => respond('createEvidenceBundle', input),
    createThread: (input) => respond('createThread', input),
    draftKnowledgeProposal: (input) => respond('draftKnowledgeProposal', input),
    draftGoalPlan: (input) => respond('draftGoalPlan', input),
    linkRepository: (input) => respond('linkRepository', input),
    readActionCenter: (input) => respond('readActionCenter', input),
    readArtifact: (input) => respond('readArtifact', input),
    readGoal: (input) => respond('readGoal', input),
    readRepositories: (input) => respond('readRepositories', input),
    readStatus: (input) => respond('readStatus', input),
    readThread: (input) => respond('readThread', input),
    readWorkspaceReviews: (input) => respond('readWorkspaceReviews', input),
    resolveActionCenterItem: (input) => respond('resolveActionCenterItem', input),
    startChat: (input) => respond('startChat', input),
    startGoal: (input) => respond('startGoal', input),
    startNanoCore: (input) => respond('startNanoCore', input),
    suggestKnowledgeRepairs: (input) => respond('suggestKnowledgeRepairs', input),
    stepGoal: (input) => respond('stepGoal', input),
    submitSteering: (input) => respond('submitSteering', input),
  };
}

describe('MCP JSON-RPC adapter', () => {
  it('handles initialize and tools/list requests', async () => {
    const handler = createJsonRpcHandler(
      createOpenKitAiInterface({ nanoCore: createFakeNanoCoreClient() })
    );

    await expect(
      handler({
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      })
    ).resolves.toMatchObject({
      id: 1,
      result: {
        capabilities: { prompts: {}, resources: {}, tools: {} },
        serverInfo: { name: '@openkit/mcp' },
      },
    });

    await expect(handler({ id: 2, jsonrpc: '2.0', method: 'tools/list' })).resolves.toMatchObject({
      id: 2,
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({
            inputSchema: expect.objectContaining({
              required: expect.arrayContaining(['workspaceId', 'displayName', 'localPath']),
            }),
            name: 'openkit.link_repository',
          }),
        ]),
      },
    });
  });

  it('calls tools and returns text plus structured content', async () => {
    const handler = createJsonRpcHandler(
      createOpenKitAiInterface({ nanoCore: createFakeNanoCoreClient() })
    );

    const response = await handler({
      id: 'call-1',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: { threadId: 'th_demo', workspaceId: 'ws_demo' },
        name: 'openkit.step_goal',
      },
    });

    expect(response).toMatchObject({
      id: 'call-1',
      result: {
        content: [expect.objectContaining({ type: 'text' })],
        structuredContent: {
          ok: true,
          summary: 'One bounded Goal Mode step completed.',
        },
      },
    });
  });

  it('reads resources and renders prompts', async () => {
    const handler = createJsonRpcHandler(
      createOpenKitAiInterface({ nanoCore: createFakeNanoCoreClient() })
    );

    await expect(
      handler({
        id: 'resource-1',
        jsonrpc: '2.0',
        method: 'resources/read',
        params: { uri: 'openkit://workspaces/ws_demo/threads/th_demo/goal' },
      })
    ).resolves.toMatchObject({
      result: {
        contents: [expect.objectContaining({ mimeType: 'application/json' })],
      },
    });

    await expect(
      handler({
        id: 'prompt-1',
        jsonrpc: '2.0',
        method: 'prompts/get',
        params: {
          arguments: { objective: 'Improve one test.', workspaceId: 'ws_demo' },
          name: 'self_improve_openkit',
        },
      })
    ).resolves.toMatchObject({
      result: {
        messages: [
          expect.objectContaining({
            content: expect.objectContaining({ type: 'text' }),
            role: 'user',
          }),
        ],
      },
    });
  });
});
