import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import * as protocol from './index.js';

const packageRoots = [
  new URL('.', import.meta.url),
  new URL('../conformance/', import.meta.url),
  new URL('../generated/', import.meta.url),
];
const legacyKnowledgeTerms = [
  ['m', 'emory'].join(''),
  ['M', 'emory'].join(''),
  ['m', 'em_'].join(''),
];

/**
 * Lists tracked protocol contract files under a root.
 *
 * @param root Directory URL to scan.
 * @returns Source, fixture, and generated schema files.
 */
function listContractFiles(root: URL): string[] {
  return readdirSync(root.pathname).flatMap((entry) => {
    const path = join(root.pathname, entry);

    if (statSync(path).isDirectory()) {
      return listContractFiles(new URL(`${entry}/`, root));
    }

    return /\.(json|ts)$/.test(path) ? [path] : [];
  });
}

describe('protocol hardening boundary', () => {
  it('keeps public protocol contracts on knowledge vocabulary', () => {
    const offenders = packageRoots.flatMap((root) =>
      listContractFiles(root).filter((path) => {
        const source = readFileSync(path, 'utf8');

        return legacyKnowledgeTerms.some((term) => source.includes(term));
      })
    );

    expect(offenders).toEqual([]);
  });

  it('does not export app/admin runtime config schemas from the stable protocol package', () => {
    const deniedExports = [
      /^RuntimeConfig/,
      /^ProviderConfig/,
      /^OAuth/,
      /^Dashboard/,
      /^AppDiagnostics/,
      /^AppSearch/,
      /^Automation/,
      /^QuickChat/,
      /^TurnFeedback/,
      /^ActionCenter/,
      /^PendingApproval/,
      /^PendingQuestion/,
      /^InternalAgent/,
      /^Settings/,
      /^Admin/,
      /^ProductMode/,
      /^Sustained/,
      /^ThreadGoal/,
      /^TaskLedger/,
      /^DelegationRequest/,
      /^ReviewRequest/,
      /^MaterializedWorkspaceRootSchema$/,
      /^WorkspaceSchema$/,
      /^StartTurnRequestSchema$/,
      /^StartTurnResponseSchema$/,
      /^GetTurnResponseSchema$/,
      /^ValidatedItemDeltaEventSchema$/,
      /^UpdateArtifactMetadataRequestSchema$/,
    ];
    const leakedExports = Object.keys(protocol).filter((key) =>
      deniedExports.some((pattern) => pattern.test(key))
    );

    expect(leakedExports).toEqual([]);
  });

  it('requires request ids on mutating command requests', () => {
    expect(() =>
      protocol.SubmitTurnInputRequestSchema.parse({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        input: 'Summarize progress',
      })
    ).toThrow();

    expect(() =>
      protocol.InterruptTurnRequestSchema.parse({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'tu_demo',
      })
    ).toThrow();

    expect(() =>
      protocol.RespondToApprovalRequestSchema.parse({
        approvalRequestId: 'ap_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'tu_demo',
        decision: 'granted',
      })
    ).toThrow();

    expect(() =>
      protocol.UpdateThreadRequestSchema.parse({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        name: 'Updated thread',
      })
    ).toThrow();

    expect(() =>
      protocol.ArchiveThreadRequestSchema.parse({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
      })
    ).toThrow();

    expect(() =>
      protocol.CancelTurnRequestSchema.parse({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'tu_demo',
      })
    ).toThrow();

    expect(() => protocol.DeleteKnowledgeEntryRequestSchema.parse({})).toThrow();
  });

  it('accepts turn assignment and trigger source without runtime-native payloads', () => {
    const turn = protocol.TurnSchema.parse({
      id: 'tu_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      agentId: 'agent_codex',
      agentSessionId: 'as_demo',
      agentProfileId: 'coder',
      triggerActor: { kind: 'user', id: 'user_demo' },
      triggerSource: { kind: 'user-input', summary: 'User started a worker turn.' },
      items: [],
      status: 'running',
      humanGate: null,
      error: null,
      configVersion: null,
      startedAt: '2026-05-27T00:00:00Z',
      completedAt: null,
      durationMs: null,
    });

    expect(turn.agentSessionId).toBe('as_demo');
    expect(turn.triggerSource?.kind).toBe('user-input');
  });

  it('accepts item lineage and the stable status, plan, and knowledge-injection item types', () => {
    const status = protocol.ItemSchema.parse({
      id: 'it_status',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      parentItemId: null,
      causationId: 'it_user',
      status: 'completed',
      createdAt: '2026-05-27T00:00:00Z',
      completedAt: '2026-05-27T00:00:01Z',
      type: 'status',
      level: 'info',
      title: 'Routing complete',
      summary: 'WorkerCoordinatorAgent selected Codex.',
    });

    const plan = protocol.ItemSchema.parse({
      id: 'it_plan',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      parentItemId: 'it_status',
      causationId: 'it_user',
      status: 'completed',
      createdAt: '2026-05-27T00:00:00Z',
      completedAt: '2026-05-27T00:00:01Z',
      type: 'plan',
      title: 'Implementation plan',
      steps: [
        { id: 'step_protocol', title: 'Update protocol schemas', status: 'completed' },
        { id: 'step_consumers', title: 'Update consumers', status: 'in_progress' },
      ],
      summary: 'Protocol hardening plan.',
    });

    const knowledgeInjection = protocol.ItemSchema.parse({
      id: 'it_knowledge',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      parentItemId: null,
      causationId: 'cap_knowledge_search',
      status: 'completed',
      createdAt: '2026-05-27T00:00:00Z',
      completedAt: '2026-05-27T00:00:01Z',
      type: 'knowledge-injection',
      summary: 'Injected project conventions.',
      knowledgeEntryIds: ['kn_project'],
      policySummary: 'Selected by workspace scope and relevance.',
    });

    expect(status.type).toBe('status');
    expect(plan.type).toBe('plan');
    expect(knowledgeInjection.type).toBe('knowledge-injection');
  });

  it('records request correlation on event envelopes', () => {
    expect(() =>
      protocol.SseEventEnvelopeSchema.parse({
        protocolVersion: protocol.PROTOCOL_VERSION,
        event: 'turn.started',
        sequence: 1,
        timestamp: '2026-05-27T00:00:00Z',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'tu_demo',
        data: { type: 'turn-started', turnId: 'tu_demo', status: 'running' },
      })
    ).toThrow();

    const parsed = protocol.SseEventEnvelopeSchema.parse({
      protocolVersion: protocol.PROTOCOL_VERSION,
      event: 'turn.started',
      sequence: 1,
      timestamp: '2026-05-27T00:00:00Z',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      requestId: '0190f4c8-0000-7000-8000-000000000123',
      data: { type: 'turn-started', turnId: 'tu_demo', status: 'running' },
    });

    expect(parsed.requestId).toBe('0190f4c8-0000-7000-8000-000000000123');
  });

  it('requires protocol versions on strict and forward-compatible event envelopes', () => {
    const envelopeWithoutProtocolVersion = {
      event: 'turn.started',
      sequence: 1,
      requestId: '0190f4c8-0000-7000-8000-000000000126',
      timestamp: '2026-05-27T00:00:00Z',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      data: { type: 'turn-started', turnId: 'tu_demo', status: 'running' },
    };

    expect(() => protocol.SseEventEnvelopeSchema.parse(envelopeWithoutProtocolVersion)).toThrow();
    expect(() =>
      protocol.ForwardCompatibleSseEventEnvelopeSchema.parse(envelopeWithoutProtocolVersion)
    ).toThrow();
  });

  it('requires protocol versions on API error payloads', () => {
    expect(() =>
      protocol.ApiErrorSchema.parse({
        code: 'invalid_request',
        message: 'The request body is invalid.',
      })
    ).toThrow();

    const parsed = protocol.ApiErrorSchema.parse({
      protocolVersion: protocol.PROTOCOL_VERSION,
      code: 'invalid_request',
      message: 'The request body is invalid.',
    });

    expect(parsed.protocolVersion).toBe(protocol.PROTOCOL_VERSION);
  });

  it('keeps strict event validation while exposing a tolerant stream parser', () => {
    const futureEnvelope = {
      protocolVersion: protocol.PROTOCOL_VERSION,
      event: 'item.futureDelta',
      sequence: 1,
      requestId: '0190f4c8-0000-7000-8000-000000000125',
      timestamp: '2026-05-27T00:00:00Z',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      data: {
        type: 'item-delta',
        itemId: 'it_future',
        itemType: 'future-item',
        deltaKind: 'future-delta',
        payload: { summary: 'Future delta payload.' },
      },
    };

    expect(() => protocol.SseEventEnvelopeSchema.parse(futureEnvelope)).toThrow();
    expect(protocol.ForwardCompatibleSseEventEnvelopeSchema.parse(futureEnvelope).event).toBe(
      'item.futureDelta'
    );

    const futureItemTypeEnvelope = {
      ...futureEnvelope,
      data: {
        ...futureEnvelope.data,
        itemType: 'future-item',
      },
    };

    expect(() => protocol.SseEventEnvelopeSchema.parse(futureItemTypeEnvelope)).toThrow();
    expect(
      protocol.ForwardCompatibleSseEventEnvelopeSchema.parse(futureItemTypeEnvelope).event
    ).toBe('item.futureDelta');

    const futureItemKnownDeltaMissingPayloadEnvelope = {
      ...futureEnvelope,
      event: 'item.delta',
      data: {
        type: 'item-delta',
        itemId: 'it_future_text',
        itemType: 'future-item',
        deltaKind: 'text-delta',
      },
    };

    expect(() =>
      protocol.SseEventEnvelopeSchema.parse(futureItemKnownDeltaMissingPayloadEnvelope)
    ).toThrow();
    expect(() =>
      protocol.ForwardCompatibleSseEventEnvelopeSchema.parse(
        futureItemKnownDeltaMissingPayloadEnvelope
      )
    ).toThrow();

    const futureItemKnownDeltaValidPayloadEnvelope = {
      ...futureItemKnownDeltaMissingPayloadEnvelope,
      data: {
        ...futureItemKnownDeltaMissingPayloadEnvelope.data,
        delta: 'Future item text payload.',
      },
    };

    expect(() =>
      protocol.SseEventEnvelopeSchema.parse(futureItemKnownDeltaValidPayloadEnvelope)
    ).toThrow();
    expect(
      protocol.ForwardCompatibleSseEventEnvelopeSchema.parse(
        futureItemKnownDeltaValidPayloadEnvelope
      ).event
    ).toBe('item.delta');

    const knownInvalidEnvelope = {
      ...futureEnvelope,
      event: 'item.delta',
      data: {
        type: 'item-delta',
        itemId: 'it_artifact',
        itemType: 'artifact-reference',
        deltaKind: 'text-delta',
        delta: 'Artifact references cannot stream text deltas.',
      },
    };

    expect(() => protocol.SseEventEnvelopeSchema.parse(knownInvalidEnvelope)).toThrow();
    expect(() =>
      protocol.ForwardCompatibleSseEventEnvelopeSchema.parse(knownInvalidEnvelope)
    ).toThrow();
  });

  it('uses delta-kind-specific payloads with required correlation fields', () => {
    expect(() =>
      protocol.ItemDeltaEventSchema.parse({
        type: 'item-delta',
        itemId: 'it_reasoning',
        itemType: 'reasoning',
        deltaKind: 'indexed-text-delta',
        delta: 'missing part id',
      })
    ).toThrow();

    expect(() =>
      protocol.ItemDeltaEventSchema.parse({
        type: 'item-delta',
        itemId: 'it_tool',
        itemType: 'tool-call',
        deltaKind: 'request-resolved',
        request: { status: 'resolved' },
      })
    ).toThrow();

    const textDelta = protocol.ItemDeltaEventSchema.parse({
      type: 'item-delta',
      itemId: 'it_assistant',
      itemType: 'assistant-message',
      deltaKind: 'text-delta',
      delta: 'hello',
    });

    const requestDelta = protocol.ItemDeltaEventSchema.parse({
      type: 'item-delta',
      itemId: 'it_tool',
      itemType: 'tool-call',
      deltaKind: 'request-started',
      requestRefId: 'req_tool_1',
      request: { title: 'Approve tool call', status: 'pending' },
    });

    expect(textDelta.deltaKind).toBe('text-delta');
    expect(requestDelta.requestRefId).toBe('req_tool_1');
  });

  it('exposes thin capability call, usage, and audit records', () => {
    expect(
      protocol.CapabilityCallSchema.parse({
        id: 'cap_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'tu_demo',
        agentSessionId: 'as_demo',
        packageSnapshotId: 'aepsnap_demo',
        runtimeOriginRef: `rto_${'a'.repeat(24)}`,
        runtimeCacheLineageRef: `rcl_${'b'.repeat(24)}`,
        requestId: '0190f4c8-0000-7000-8000-000000000124',
        sourceIds: ['repo_default'],
        capabilityId: 'llm.gateway.responses',
        status: 'succeeded',
        summary: 'Responses gateway call completed.',
        errorCode: null,
        startedAt: '2026-05-27T00:00:00Z',
        completedAt: '2026-05-27T00:00:01Z',
      })
    ).toMatchObject({
      packageSnapshotId: 'aepsnap_demo',
      runtimeOriginRef: `rto_${'a'.repeat(24)}`,
      runtimeCacheLineageRef: `rcl_${'b'.repeat(24)}`,
      sourceIds: ['repo_default'],
      status: 'succeeded',
    });

    expect(() =>
      protocol.CapabilityCallSchema.parse({
        id: 'cap_raw_runtime',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'tu_demo',
        agentSessionId: 'as_demo',
        packageSnapshotId: 'aepsnap_demo',
        runtimeOriginRef: '019f0000-0000-7000-8000-000000000001',
        runtimeCacheLineageRef: 'raw-cache-lineage',
        capabilityId: 'llm.gateway.responses',
        status: 'running',
        summary: null,
        errorCode: null,
        startedAt: null,
        completedAt: null,
      })
    ).toThrow();

    expect(
      protocol.UsageRecordSchema.parse({
        id: 'usage_demo',
        workspaceId: 'ws_demo',
        responsibleUserId: 'user_demo',
        threadId: 'th_demo',
        turnId: 'tu_demo',
        itemId: 'it_assistant',
        capabilityCallId: 'cap_demo',
        sourceIds: ['repo_default'],
        unit: 'usd',
        quantity: 0.042,
        source: 'llm.gateway.cost_estimate',
        recordedAt: '2026-05-27T00:00:01Z',
      })
    ).toMatchObject({ sourceIds: ['repo_default'], unit: 'usd' });

    expect(
      protocol.AuditEventSchema.parse({
        id: 'audit_demo',
        workspaceId: 'ws_demo',
        action: 'capability.call',
        resource: 'llm.gateway.responses',
        outcome: 'succeeded',
        requestId: '0190f4c8-0000-7000-8000-000000000124',
        summary: 'Capability call succeeded.',
        occurredAt: '2026-05-27T00:00:01Z',
      }).outcome
    ).toBe('succeeded');

    expect(
      protocol.AuditEventSchema.parse({
        id: 'audit_server_demo',
        action: 'vault.resolve',
        resource: 'vault:vault_github',
        outcome: 'succeeded',
        summary: 'Server vault reference resolved.',
        occurredAt: '2026-05-27T00:00:01Z',
      }).workspaceId
    ).toBeNull();
  });
});
