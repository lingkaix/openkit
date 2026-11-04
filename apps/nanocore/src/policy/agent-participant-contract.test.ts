import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { allocateEntityId, PolicyWriteProposalV1Schema } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { listWorkspaceUsageRecords } from '../capability/usage-ledger.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { PiAiGatewayClient } from '../llm/pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  createTestStore,
  createTestWorkspaceDb,
} from '../test-support/store.js';
import { createAgentPolicyParticipant } from './agent-gate-provider.js';
import { readAdmittedPolicyDocument, recordPolicyWriteDecision } from './configuration.js';
import { type PolicyProposal, policyDigest, preparePolicyDocument } from './statements.js';

const cleanup: (() => void)[] = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const close of cleanup.splice(0)) close();
});

describe('agent Policy participant public contract', () => {
  it('returns the typed assessment through the public participant and discloses only the safe summary', async () => {
    const fixture = await createFixture();
    const rawArgumentMarker = 'raw-tool-argument-must-not-reach-the-agent';
    const suppliedProposal: PolicyProposal = fixture.proposal;
    const withRawArguments = { ...suppliedProposal, arguments: { privateBody: rawArgumentMarker } };
    let received: TranscriptContext | undefined;
    let selected: { readonly id: string; readonly provider: string } | undefined;
    fixture.faux.setResponses([
      (context, _options, _state, model) => {
        received = context;
        selected = { id: model.id, provider: model.provider };
        return fauxAssistantMessage(
          {
            type: 'toolCall',
            id: 'assessment-1',
            name: 'policy_gate-result',
            arguments: fixture.assessment,
          },
          { stopReason: 'toolUse' }
        );
      },
    ]);

    await expect(
      fixture.participant.invoke({
        binding: fixture.binding,
        proposal: withRawArguments,
        advice: [],
        signal: new AbortController().signal,
      })
    ).resolves.toEqual(fixture.assessment);

    expect(fixture.faux.state.callCount).toBe(1);
    expect(selected).toEqual({ id: 'fixture-model', provider: 'fixture' });
    expect(offeredToolNames(received)).toEqual(['policy_gate-result']);
    expect(JSON.stringify(received)).not.toContain(rawArgumentMarker);
    expect(JSON.parse(disclosedUserText(received))).toEqual({ proposal: suppliedProposal });
    const usage = listWorkspaceUsageRecords(fixture.workspaceDb, fixture.workspace.id);
    expect(
      usage.some(
        (row) => row.unit === 'tokens' && row.quantity > 0 && row.modelId === 'gate-default'
      )
    ).toBe(true);
  });

  it('refuses a malformed assessment and stops at the two-model-turn bound', async () => {
    const fixture = await createFixture();
    fixture.faux.setResponses([
      fauxAssistantMessage(
        {
          type: 'toolCall',
          id: 'malformed-1',
          name: 'policy_gate-result',
          arguments: { decision: 'allow' },
        },
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage(
        {
          type: 'toolCall',
          id: 'malformed-2',
          name: 'policy_gate-result',
          arguments: { decision: 'allow' },
        },
        { stopReason: 'toolUse' }
      ),
    ]);

    await expect(
      fixture.participant.invoke({
        binding: fixture.binding,
        proposal: fixture.proposal,
        advice: [],
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('The agent gate has no completed valid assessment.');
    expect(fixture.faux.state.callCount).toBe(2);
  });

  it('refuses a text-only model reply that submits no assessment', async () => {
    const fixture = await createFixture();
    fixture.faux.setResponses([
      fauxAssistantMessage('Allow this request.', { stopReason: 'stop' }),
    ]);

    await expect(
      fixture.participant.invoke({
        binding: fixture.binding,
        proposal: fixture.proposal,
        advice: [],
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('The agent gate has no completed valid assessment.');
    expect(fixture.faux.state.callCount).toBe(1);
  });

  it('stops the loop with the cancellation outcome when the abort signal fires', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const reason = new DOMException('The Policy participant was cancelled.', 'AbortError');
    fixture.faux.setResponses([
      () => {
        controller.abort(reason);
        return fauxAssistantMessage(
          {
            type: 'toolCall',
            id: 'assessment-after-cancel',
            name: 'policy_gate-result',
            arguments: fixture.assessment,
          },
          { stopReason: 'toolUse' }
        );
      },
    ]);

    await expect(
      fixture.participant.invoke({
        binding: fixture.binding,
        proposal: fixture.proposal,
        advice: [],
        signal: controller.signal,
      })
    ).rejects.toBe(reason);
    expect(fixture.faux.state.callCount).toBe(1);
  });
});

/** Builds one admitted agent gate and its faux Gateway seam without opening private backends. */
async function createFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'policy-participant-'));
  const coreDb = createTestCoreDb(dataRoot);
  const store = createTestStore({ dataRoot });
  const userId = ensureLocalUser(coreDb);
  const human = { kind: 'human' as const, id: userId };
  const agentId = 'policy-reviewer';
  const workspace = await store.createWorkspace('Agent participant contract');
  const thread = await store.createThread(workspace.id, 'Admitted Tool request');
  const turn = await store.createTurn(
    workspace.id,
    thread.id,
    'Read the issue.',
    { kind: 'agent', id: 'requesting-worker', responsibleUserId: userId },
    null,
    { agentId: 'requesting-worker', captureCoverage: { scope: 'server', value: 'on' } }
  );
  const workspaceDb = createTestWorkspaceDb(dataRoot, workspace.id);
  cleanup.push(() => closeTestCoreDb(workspaceDb));
  cleanup.push(() => closeTestCoreDb(coreDb));
  cleanup.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const scope = {
    subjects: [human],
    actions: ['tool.use'],
    resources: [
      { kind: 'mcp-tool', workspaceId: workspace.id, serverId: 'issues', toolName: 'read' },
    ],
  };
  const common = {
    author: human,
    authority: { kind: 'human', userId },
    authoredAt: new Date().toISOString(),
    state: 'active',
    lifetime: {
      anchor: {
        owner: { kind: 'workspace', workspaceId: workspace.id },
        kind: 'workspace',
        id: workspace.id,
      },
    },
  };
  const declaration = {
    ...common,
    kind: 'agent-principal',
    id: 'reviewer-principal',
    agentId,
    creator: human,
    responsibleHumanId: userId,
    responsibility: human,
    scope: { ...scope, subjects: [{ kind: 'agent', id: agentId }] },
  };
  const document = preparePolicyDocument({
    current: { schemaVersion: 1, statements: [] },
    proposed: {
      schemaVersion: 1,
      statements: [
        declaration,
        {
          ...common,
          kind: 'binding',
          id: 'review-issues',
          scope,
          operation: 'mcp.call-tool',
          stage: 'decide',
          mode: 'gate',
          participant: { kind: 'agent', id: agentId, version: policyDigest(declaration) },
          inputDisclosure: scope,
          order: 0,
          timeoutMs: 20_000,
          circuit: { failures: 1, recoveryAfterMs: 60_000 },
        },
      ],
    },
    userId,
    now: common.authoredAt,
  }).document;
  const binding = document.statements.find((statement) => statement.kind === 'binding');
  if (!binding) throw new Error('Expected an admitted agent binding.');
  await recordPolicyWriteDecision({
    coreDb,
    actor: { kind: 'local', userId },
    candidate: { artifactId: allocateEntityId('ar'), contentDigest: policyDigest(document) },
    proposal: PolicyWriteProposalV1Schema.parse({
      schemaVersion: 1,
      proposer: human,
      rationale: 'Fixture for a previously human-admitted gate.',
      baseRevision: policyDigest({ schemaVersion: 1, statements: [] }),
      proposed: document,
      validation: 'valid',
    }),
    requestId: randomUUID(),
    threadId: thread.id,
    turnId: turn.id,
  });
  expect(readAdmittedPolicyDocument(coreDb, document)).toEqual(document);
  const providerRegistry = new ProviderRegistry([
    {
      id: 'fixture',
      adapter: 'openai-compatible',
      displayName: 'Fixture transport',
      kind: 'llm',
      enabled: true,
      models: ['fixture-model'],
      credential: { kind: 'none' },
      capabilities: { llm: { responses: 'supported', chatCompletions: 'supported' } },
      modelMetadata: {
        'fixture-model': { tool_call: true, limit: { context: 64_000, output: 2000 } },
      },
    },
  ]);
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot,
    openKitConfig: { policy: { mediation: document, workDataCapture: true } },
    providerRegistry,
    gatewayConfig: {
      schemaVersion: 1,
      enabled: true,
      requiredFeatures: [],
      defaultLogicalModelId: 'gate-default',
      logicalModels: [
        {
          id: 'gate-default',
          displayName: 'Default gate model',
          contextManagement: [{ type: 'compaction', compactThreshold: 32_000 }],
          routes: [
            { id: 'fixture-route', providerProfileId: 'fixture', providerModel: 'fixture-model' },
          ],
        },
      ],
    },
  });
  const faux = fauxProvider({
    api: 'openai-responses',
    provider: 'fixture',
    models: [{ id: 'fixture-model' }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const participant = createAgentPolicyParticipant({
    coreDb,
    store,
    runtimeConfig: () => snapshot,
    dispatcher: new LLMGatewayProviderDispatcher({ piAiClient: new PiAiGatewayClient({ models }) }),
    resolveGatewayProvider: () => ({
      id: 'fixture',
      adapterId: 'fixture',
      displayName: 'Fixture transport',
      models: ['fixture-model'],
      baseUrl: null,
      apiKey: '',
      requiresApiKey: false,
      gatewayCapabilities: { responses: 'native', chatCompletions: 'native' },
      modelMetadata: {
        'fixture-model': { tool_call: true, limit: { context: 64_000, output: 2000 } },
      },
    }),
  });
  const proposal: PolicyProposal = {
    operation: 'mcp.call-tool',
    workspaceId: workspace.id,
    capabilityCallId: allocateEntityId('cap'),
    resource: {
      kind: 'mcp-tool' as const,
      workspaceId: workspace.id,
      serverId: 'issues',
      toolName: 'read',
    },
    inputReferences: {
      argumentsDigest: policyDigest({ issue: 1 }),
      catalogRevision: 'catalog-fixture',
      packageSnapshotId: 'package-fixture',
      schemaDigest: null,
    },
    inputAttributes: {},
    subject: {
      principal: human,
      onBehalfOf: null,
      actor: { kind: 'agent', id: 'requesting-worker', responsibleUserId: userId },
      process: { workspaceId: workspace.id, threadId: thread.id, turnId: turn.id },
      credentialKind: 'worker-package',
      responsibleHumanId: userId,
    },
  };
  const assessment = {
    decision: 'allow',
    risk: 'One read-only issue request.',
    authorizationAssessment: 'The declared agent domain covers this read.',
    rationale: 'The safe summary is sufficient.',
  };
  return { assessment, binding, faux, participant, proposal, workspace, workspaceDb };
}

/** Reads the model-visible function names admitted into the disclosed transcript. */
function offeredToolNames(context: TranscriptContext | undefined): string[] {
  return (
    context?.messages.flatMap((message) =>
      message.role === 'system' ? (message.toolsAdded ?? []).map((tool) => tool.name) : []
    ) ?? []
  );
}

/** Reads the single disclosed user text that carries the safe proposal summary. */
function disclosedUserText(context: TranscriptContext | undefined): string {
  const message = context?.messages.find((candidate) => candidate.role === 'user');
  if (!message || message.role !== 'user') throw new Error('Expected a disclosed user message.');
  return typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
}
