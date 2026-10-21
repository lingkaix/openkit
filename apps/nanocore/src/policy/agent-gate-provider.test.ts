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
import { afterEach, expect, it, vi } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
} from '../capability/usage-ledger.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { readWorkObservationBody } from '../evidence-bundles.js';
import { FsStore } from '../lib/store.js';
import { PiAiGatewayClient } from '../llm/pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { readWorkObservations } from '../storage/work-observations.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createAgentPolicyParticipant } from './agent-gate-provider.js';
import { readAdmittedPolicyDocument, recordPolicyWriteDecision } from './configuration.js';
import { type PolicyProposal, policyDigest, preparePolicyDocument } from './statements.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});

it('runs the native agent participant through the default Gateway model with real capture and agent usage attribution', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'policy-agent-provider-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const human = { kind: 'human' as const, id: userId };
  const agentId = 'policy-reviewer';
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Agent gate capture');
  const thread = await store.createThread(workspace.id, 'Admitted Tool request');
  const turn = await store.createTurn(
    workspace.id,
    thread.id,
    'Read the issue.',
    { kind: 'agent', id: 'requesting-worker', responsibleUserId: userId },
    null,
    { agentId: 'requesting-worker', captureCoverage: { scope: 'server', value: 'on' } }
  );
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  cleanup.push(() => {
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
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
  if (!binding) throw new Error('Expected admitted agent binding.');
  recordPolicyWriteDecision({
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
  const assessment = {
    decision: 'allow',
    risk: 'One read-only issue request.',
    authorizationAssessment: 'The declared agent domain covers this read.',
    rationale: 'The safe summary is sufficient.',
  };
  const faux = fauxProvider({
    api: 'openai-responses',
    provider: 'fixture',
    models: [{ id: 'fixture-model' }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  let received: TranscriptContext | undefined;
  faux.setResponses([
    (context) => {
      received = context;
      return fauxAssistantMessage(
        { type: 'toolCall', id: 'assessment-1', name: 'policy_gate-result', arguments: assessment },
        { stopReason: 'toolUse' }
      );
    },
  ]);
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
    serverId: 'issues',
    toolName: 'read',
    argumentsDigest: policyDigest({ issue: 1 }),
    catalogRevision: 'catalog-fixture',
    packageDigest: 'package-fixture',
    schemaDigest: null,
    capabilityCallId: allocateEntityId('cap'),
    subject: {
      principal: human,
      onBehalfOf: null,
      actor: { kind: 'agent', id: 'requesting-worker', responsibleUserId: userId },
      process: { workspaceId: workspace.id, threadId: thread.id, turnId: turn.id },
      credentialKind: 'worker-package',
      responsibleHumanId: userId,
    },
  };
  const rawArgumentMarker = 'raw-arguments-must-not-enter-gate-model-or-capture';
  const suppliedProposal = { ...proposal, arguments: { privateBody: rawArgumentMarker } };
  await expect(
    participant.invoke({
      binding,
      proposal: suppliedProposal,
      advice: [],
      signal: new AbortController().signal,
    })
  ).resolves.toEqual(assessment);
  expect(faux.state.callCount).toBe(1);
  expect(
    received?.messages.flatMap((message) =>
      message.role === 'system' ? (message.toolsAdded ?? []).map((tool) => tool.name) : []
    )
  ).toEqual(['policy_gate-result']);
  expect(JSON.stringify(received)).not.toContain(rawArgumentMarker);
  expect(JSON.stringify(received)).toContain(proposal.argumentsDigest);
  const calls = listWorkspaceCapabilityCalls(workspaceDb, workspace.id);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    agentId,
    threadId: thread.id,
    turnId: turn.id,
    capabilityId: 'inference.local.policy-agent-gate',
    status: 'succeeded',
    agentSessionId: null,
  });
  const usage = listWorkspaceUsageRecords(workspaceDb, workspace.id);
  expect(usage.length).toBeGreaterThan(0);
  expect(
    usage.every(
      (row) =>
        row.agentId === agentId &&
        row.responsibleUserId === userId &&
        row.turnId === turn.id &&
        row.capabilityCallId === calls[0]!.id
    )
  ).toBe(true);
  expect(
    usage.some((row) => row.unit === 'tokens' && row.quantity > 0 && row.modelId === 'gate-default')
  ).toBe(true);
  expect(listWorkspaceAuditEvents(workspaceDb, workspace.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        agentId,
        capabilityCallId: calls[0]!.id,
        actor: { kind: 'agent', id: agentId, responsibleUserId: userId },
      }),
    ])
  );
  const observations = readWorkObservations(workspaceDb, { threadId: thread.id, turnId: turn.id });
  expect(observations.some((row) => row.type === 'model.observed')).toBe(true);
  const bodies = observations
    .filter((row) => row.type === 'content.published')
    .flatMap((row) =>
      (row.refs ?? []).map((ref) => {
        const original = observations.find((candidate) => candidate.id === row.parent)!;
        const bytes = readWorkObservationBody(workspaceDb, {
          threadId: thread.id,
          turnId: turn.id,
          bundleId: ref.locator,
          createdAt: original.ts,
          sha256: ref.digest!,
        });
        expect(bytes).not.toBeNull();
        return { direction: original.payload.direction, text: new TextDecoder().decode(bytes!) };
      })
    );
  expect(bodies.some((body) => body.direction === 'request')).toBe(true);
  expect(bodies.some((body) => body.direction === 'response')).toBe(true);
  expect(bodies.map((body) => body.text).join('')).not.toContain(rawArgumentMarker);
});
