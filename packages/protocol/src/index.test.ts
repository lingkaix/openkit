import { describe, expect, it } from 'vitest';
import type { StopReason } from './index.js';
import {
  ActorRefSchema,
  AgentSessionSchema,
  AgentSessionStatusSchema,
  AgentSessionUpdatedEventSchema,
  ApprovalStatusSchema,
  ArchiveThreadRequestSchema,
  ArtifactSchema,
  CancelTurnRequestSchema,
  CreateKnowledgeEntryRequestSchema,
  CreateThreadRequestSchema,
  DeleteKnowledgeEntryRequestSchema,
  ForwardCompatibleSseEventEnvelopeSchema,
  GetArtifactResponseSchema,
  GetThreadResponseSchema,
  InterruptTurnRequestSchema,
  ItemDeltaKindSchema,
  ItemSchema,
  ItemStatusSchema,
  ListArtifactsResponseSchema,
  ListKnowledgeEntriesResponseSchema,
  ListThreadItemsResponseSchema,
  ListThreadsResponseSchema,
  MetaResponseSchema,
  PROTOCOL_VERSION,
  ProductSseEventEnvelopeSchema,
  ProductTurnSchema,
  RespondToApprovalRequestSchema,
  ServerEventSchema,
  SseEventEnvelopeSchema,
  SseEventNameSchema,
  StopReasonSchema,
  SubmitTurnInputRequestSchema,
  ThreadSchema,
  TurnHumanGateSchema,
  TurnReadProjectionSchema,
  TurnSchema,
  TurnStatusSchema,
  UpdateThreadRequestSchema,
  UpdateWorkspaceRequestSchema,
  UsageRecordSchema,
  WorkspaceRecordSchema,
  WorkspaceResourcesSchema,
} from './index.js';

describe('canonical enums', () => {
  it('exports the canonical turn status values', () => {
    expect(TurnStatusSchema.options).toEqual([
      'pending',
      'running',
      'awaiting_human',
      'completed',
      'interrupted',
      'cancelled',
      'failed',
    ]);
  });

  it('exports the canonical approval status values', () => {
    expect(ApprovalStatusSchema.options).toEqual([
      'pending',
      'granted',
      'denied',
      'expired',
      'superseded',
      'withdrawn',
    ]);
  });

  it('exports the canonical AgentSession status values', () => {
    expect(AgentSessionStatusSchema.options).toEqual([
      'created',
      'initializing',
      'ready',
      'busy',
      'idle',
      'degraded',
      'suspended',
      'interrupted',
      'failed',
      'closed',
    ]);
  });

  it('exports the canonical item delta kind values', () => {
    expect(ItemDeltaKindSchema.options).toEqual([
      'text-delta',
      'indexed-text-delta',
      'part-started',
      'output-delta',
      'snapshot-updated',
      'progress-updated',
      'request-started',
      'request-resolved',
      'interaction-delta',
      'artifact-updated',
      'knowledge-injection-updated',
    ]);
  });

  it('exports the canonical item status values', () => {
    expect(ItemStatusSchema.options).toEqual(['in_progress', 'completed', 'failed', 'declined']);
  });

  it('accepts only compact attributable actor references', () => {
    const actor = {
      kind: 'user',
      id: 'user_demo',
    } as const;

    expect(ActorRefSchema.parse(actor)).toEqual(actor);
    expect(ActorRefSchema.safeParse({ ...actor, responsibleUserId: 'user_demo' }).success).toBe(
      false
    );
    expect(
      ActorRefSchema.safeParse({
        kind: 'automation',
        id: 'automation_demo',
        responsibleUserId: 'user_demo',
      }).success
    ).toBe(true);
    expect(ActorRefSchema.safeParse({ kind: 'automation', id: 'automation_demo' }).success).toBe(
      false
    );
    expect(ActorRefSchema.safeParse({ ...actor, displayName: 'Demo User' }).success).toBe(false);
  });

  it('exports the canonical stop reason values', () => {
    const validStopReason: StopReason = 'completed';

    expect(validStopReason).toBe('completed');
    expect(StopReasonSchema.options).toEqual([
      'completed',
      'error',
      'aborted',
      'length',
      'ask_user',
      'budget_exhausted',
    ]);
    expect(StopReasonSchema.safeParse('completed' satisfies StopReason).success).toBe(true);
    expect(StopReasonSchema.safeParse('error').success).toBe(true);
    expect(StopReasonSchema.safeParse('aborted').success).toBe(true);
    expect(StopReasonSchema.safeParse('length').success).toBe(true);
    expect(StopReasonSchema.safeParse('ask_user').success).toBe(true);
    expect(StopReasonSchema.safeParse('budget_exhausted').success).toBe(true);
    expect(StopReasonSchema.safeParse('unknown').success).toBe(false);
  });
});

describe('protocol schemas', () => {
  it('projects ordinary SSE without AgentSession events or Turn identity', () => {
    const turn = {
      id: 'tu_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      triggerActor: { kind: 'user' as const, id: 'user_demo' },
      items: [],
      status: 'running' as const,
      humanGate: null,
      error: null,
      agentSessionId: 'as_demo',
      configVersion: null,
      startedAt: '2026-04-15T00:00:00Z',
      completedAt: null,
      durationMs: null,
    };
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      sequence: 1,
      requestId: null,
      timestamp: '2026-04-15T00:00:00Z',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
    };

    for (const turnEvent of [
      { event: 'turn.updated', data: { type: 'turn-updated', turn } },
      {
        event: 'turn.completed',
        data: {
          type: 'turn-completed',
          stopReason: 'completed',
          turn: { ...turn, status: 'completed', completedAt: '2026-04-15T00:00:01Z' },
        },
      },
    ]) {
      const parsed = ProductSseEventEnvelopeSchema.parse({ ...envelope, ...turnEvent });

      expect(parsed.data).not.toHaveProperty('turn.agentSessionId');
    }

    const agentSessionEvent = {
      ...envelope,
      event: 'agent.session.updated',
      data: {
        type: 'agent-session-updated',
        agentSession: {
          id: 'as_demo',
          agentId: 'agent_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          status: 'busy',
          message: null,
          createdAt: '2026-04-15T00:00:00Z',
          updatedAt: '2026-04-15T00:00:01Z',
        },
      },
    };

    expect(ForwardCompatibleSseEventEnvelopeSchema.safeParse(agentSessionEvent).success).toBe(true);
    for (const internalMarker of [
      agentSessionEvent,
      { ...agentSessionEvent, event: 'error' },
      { ...agentSessionEvent, data: { type: 'error', code: 'demo', message: 'Demo.' } },
    ]) {
      expect(ProductSseEventEnvelopeSchema.safeParse(internalMarker).success).toBe(false);
    }

    const malformedTurn = {
      ...turn,
      items: [
        {
          id: 'it_answer_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'tu_demo',
          status: 'completed' as const,
          createdAt: '2026-04-15T00:00:02Z',
          completedAt: '2026-04-15T00:00:03Z',
          type: 'user-input-response' as const,
          actor: { kind: 'user' as const, id: 'user_demo' },
          causationId: 'req_answer_demo',
          userInputRequestId: 'ui_demo',
          answers: { question: ['Answer'] },
        },
      ],
    };

    expect(
      ProductSseEventEnvelopeSchema.safeParse({
        ...envelope,
        event: 'turn.updated',
        data: { type: 'turn-updated', turn: malformedTurn },
      }).success
    ).toBe(false);
  });

  it('accepts a workspace-scoped SSE envelope', () => {
    const parsed = SseEventEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      event: 'turn.started',
      sequence: 1,
      requestId: '0190f4c8-0000-7000-8000-000000000201',
      timestamp: '2026-04-15T00:00:00Z',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      data: { type: 'turn-started', turnId: 'tu_demo', status: 'running' },
    });

    expect(parsed.workspaceId).toBe('ws_demo');
  });

  it('requires request correlation for knowledge deletion commands', () => {
    const parsed = DeleteKnowledgeEntryRequestSchema.parse({
      requestId: '0190f4c8-0000-7000-8000-000000000206',
    });

    expect(parsed.requestId).toBe('0190f4c8-0000-7000-8000-000000000206');
    expect(() => DeleteKnowledgeEntryRequestSchema.parse({})).toThrow();
  });

  it('accepts source references when creating knowledge entries', () => {
    const parsed = CreateKnowledgeEntryRequestSchema.parse({
      requestId: '0190f4c8-0000-7000-8000-000000000207',
      kind: 'project-context',
      title: 'Release plan',
      content: 'Release cadence is weekly.',
      sourceReferences: ['source:ks_release'],
    });

    expect(parsed.sourceReferences).toEqual(['source:ks_release']);
  });

  it('accepts knowledge list responses from the protocol package', () => {
    const parsed = ListKnowledgeEntriesResponseSchema.parse({
      items: [
        {
          id: 'kn_demo',
          kind: 'preference',
          title: 'Preference',
          content: 'Use concise implementation notes.',
          createdAt: '2026-04-15T00:00:00Z',
          updatedAt: '2026-04-15T00:00:00Z',
        },
      ],
    });

    expect(parsed.items).toHaveLength(1);
  });

  it('accepts durable thread item replay responses from the protocol package', () => {
    const parsed = ListThreadItemsResponseSchema.parse({
      items: [
        {
          id: 'it_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'tu_demo',
          type: 'assistant-message',
          status: 'completed',
          text: 'Ready.',
          createdAt: '2026-04-15T00:00:00Z',
          completedAt: '2026-04-15T00:00:00Z',
        },
      ],
      nextCursor: null,
    });

    expect(parsed.nextCursor).toBeNull();
  });

  it('accepts item delta events with explicit delta kinds', () => {
    const parsed = SseEventEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      event: 'item.delta',
      sequence: 2,
      requestId: '0190f4c8-0000-7000-8000-000000000202',
      timestamp: '2026-04-15T00:00:00Z',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      data: {
        type: 'item-delta',
        itemId: 'it_demo',
        itemType: 'command-execution',
        deltaKind: 'output-delta',
        delta: 'stdout line',
      },
    });

    expect(parsed.data).toMatchObject({ type: 'item-delta', deltaKind: 'output-delta' });
  });

  it('requires nullable request correlation on strict SSE envelopes', () => {
    expect(() =>
      SseEventEnvelopeSchema.parse({
        event: 'turn.started',
        sequence: 1,
        timestamp: '2026-04-15T00:00:00Z',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'tu_demo',
        data: { type: 'turn-started', turnId: 'tu_demo', status: 'running' },
      })
    ).toThrow();

    const parsed = SseEventEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      event: 'workspace.updated',
      sequence: 1,
      requestId: null,
      timestamp: '2026-04-15T00:00:00Z',
      workspaceId: 'ws_demo',
      data: {
        type: 'workspace-updated',
        workspace: {
          id: 'ws_demo',
          name: 'Workspace',
          kind: 'code',
          status: 'active',
          counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
          createdAt: '2026-04-15T00:00:00Z',
          updatedAt: '2026-04-15T00:00:00Z',
        },
      },
    });

    expect(parsed.requestId).toBeNull();
  });

  it('requires protocol versions on strict SSE envelopes', () => {
    expect(() =>
      SseEventEnvelopeSchema.parse({
        event: 'turn.started',
        sequence: 1,
        requestId: '0190f4c8-0000-7000-8000-000000000202',
        timestamp: '2026-04-15T00:00:00Z',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'tu_demo',
        data: { type: 'turn-started', turnId: 'tu_demo', status: 'running' },
      })
    ).toThrow();
  });

  it('accepts forward-compatible unknown stream payloads without relaxing strict parsing', () => {
    const payload = {
      protocolVersion: PROTOCOL_VERSION,
      event: 'item.futureDelta',
      sequence: 3,
      requestId: '0190f4c8-0000-7000-8000-000000000203',
      timestamp: '2026-04-15T00:00:00Z',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      data: {
        type: 'item-delta',
        itemId: 'it_demo',
        itemType: 'future-item',
        deltaKind: 'future-delta',
        payload: { summary: 'Future payload.' },
      },
    };

    expect(() => SseEventEnvelopeSchema.parse(payload)).toThrow();
    expect(ForwardCompatibleSseEventEnvelopeSchema.parse(payload).data.type).toBe('item-delta');
    expect(() =>
      ForwardCompatibleSseEventEnvelopeSchema.parse({
        ...payload,
        event: 'turn.started',
        data: {
          type: 'turn-started',
          turnId: 'tu_demo',
        },
      })
    ).toThrow();
    expect(
      ForwardCompatibleSseEventEnvelopeSchema.parse({
        ...payload,
        event: 'item.created',
        data: {
          type: 'item-created',
          item: {
            id: 'it_future',
            type: 'future-item',
            payload: { title: 'Future item payload.' },
          },
        },
      }).data.type
    ).toBe('item-created');
  });

  it('requires a workspace on turn requests', () => {
    const parsed = SubmitTurnInputRequestSchema.parse({
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      requestId: '0190f4c8-0000-7000-8000-000000000123',
      input: 'Summarize progress',
      modelId: 'model_codex',
    });

    expect(parsed.workspaceId).toBe('ws_demo');
    expect(parsed.requestId).toBe('0190f4c8-0000-7000-8000-000000000123');
    expect(parsed.modelId).toBe('model_codex');
  });

  it('rejects empty model overrides on turn requests', () => {
    expect(() =>
      SubmitTurnInputRequestSchema.parse({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: '0190f4c8-0000-7000-8000-000000000128',
        input: 'Summarize progress',
        modelId: '',
      })
    ).toThrow();
  });

  it('accepts an exact structured response to a user-input Gate', () => {
    const parsed = SubmitTurnInputRequestSchema.parse({
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      requestId: '0190f4c8-0000-7000-8000-000000000129',
      answers: {
        branch: ['main'],
      },
    });

    expect(parsed).toEqual({
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      requestId: '0190f4c8-0000-7000-8000-000000000129',
      answers: {
        branch: ['main'],
      },
    });
  });

  it.each([
    {
      name: 'mixed ordinary and Gate fields',
      request: {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'tu_demo',
        requestId: '0190f4c8-0000-7000-8000-000000000130',
        input: 'main',
        answers: { branch: ['main'] },
      },
    },
    {
      name: 'empty answer selection',
      request: {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'tu_demo',
        requestId: '0190f4c8-0000-7000-8000-000000000131',
        answers: { branch: [] },
      },
    },
    {
      name: 'multiple answer selection',
      request: {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'tu_demo',
        requestId: '0190f4c8-0000-7000-8000-000000000132',
        answers: { branch: ['main', 'release'] },
      },
    },
  ])('rejects $name on turn requests', ({ request }) => {
    expect(() => SubmitTurnInputRequestSchema.parse(request)).toThrow();
  });

  it('accepts request correlation ids on interrupt requests', () => {
    const parsed = InterruptTurnRequestSchema.parse({
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      requestId: '0190f4c8-0000-7000-8000-000000000124',
    });

    expect(parsed.requestId).toBe('0190f4c8-0000-7000-8000-000000000124');
  });

  it('accepts request correlation ids on approval responses', () => {
    const parsed = RespondToApprovalRequestSchema.parse({
      approvalRequestId: 'ap_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      decision: 'granted',
      requestId: '0190f4c8-0000-7000-8000-000000000125',
    });

    expect(parsed.requestId).toBe('0190f4c8-0000-7000-8000-000000000125');
  });

  it('rejects meta responses that advertise unknown SSE event families', () => {
    expect(() =>
      MetaResponseSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: ['core.approvals', 'core.interrupt'],
        eventFamilies: ['turn.started', 'item.unknown'],
      })
    ).toThrow();
  });

  it('exports the pinned protocol version', () => {
    expect(PROTOCOL_VERSION).toBe('0.5.0');
  });

  it('requires an explicit nullable responsible user on every usage record', () => {
    const usage = {
      id: 'use_demo',
      workspaceId: 'ws_demo',
      threadId: null,
      turnId: null,
      unit: 'requests',
      quantity: 1,
      recordedAt: '2026-07-19T00:00:00Z',
    } as const;

    expect(UsageRecordSchema.safeParse(usage).success).toBe(false);
    expect(UsageRecordSchema.safeParse({ ...usage, responsibleUserId: null }).success).toBe(true);
    expect(
      UsageRecordSchema.parse({ ...usage, responsibleUserId: 'user_demo' }).responsibleUserId
    ).toBe('user_demo');
  });

  it('accepts product-safe sandbox summaries on AgentSessions', () => {
    const session = AgentSessionSchema.parse({
      id: 'session_demo',
      agentId: 'agent_codex_host',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      status: 'ready',
      message: null,
      sandboxSummary: {
        access: 'read-write',
        workspaceRootRefs: ['outputs'],
        summary: 'Workspace artifacts are writable.',
      },
      createdAt: '2026-04-15T00:00:00Z',
      updatedAt: '2026-04-15T00:00:00Z',
    });

    expect(session.sandboxSummary?.workspaceRootRefs[0]).toBe('outputs');
  });

  it('round-trips meta responses with namespaced capability flags and optional item metadata', () => {
    const metaResponse = {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [
        'core.approvals',
        'core.artifacts',
        'core.interrupt',
        'core.knowledge.edit',
        'core.agent_session.visible',
        'core.stream.replay',
      ],
      eventFamilies: ['turn.started', 'item.delta', 'item.completed'],
      itemTypes: ['assistant-message', 'command-execution'],
      itemDeltaKinds: ['text-delta', 'output-delta'],
    };

    expect(MetaResponseSchema.parse(metaResponse)).toEqual(metaResponse);
  });

  it('parses a thin workspace record without inline resources', () => {
    const parsed = WorkspaceRecordSchema.parse({
      id: 'ws_demo',
      name: 'Demo Workspace',
      kind: 'code',
      status: 'active',
      defaults: {
        defaultModelId: 'model_gpt_5_4',
        defaultAgentId: 'agent_planner',
        defaultSkillIds: ['skill_protocol'],
      },
      counts: {
        threadCount: 2,
        artifactCount: 1,
        knowledgeEntryCount: 3,
      },
      importedFrom: {
        sourceDeploymentId: 'dep_source',
        sourceWorkspaceId: 'ws_source',
        exportCreatedAt: '2026-04-14T00:00:00Z',
        manifestDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
      createdAt: '2026-04-15T00:00:00Z',
      updatedAt: '2026-04-15T00:00:00Z',
    });

    expect(parsed.name).toBe('Demo Workspace');
    expect(parsed.importedFrom?.sourceWorkspaceId).toBe('ws_source');
  });

  it('accepts the Quick Chat workspace kind', () => {
    const parsed = WorkspaceRecordSchema.parse({
      id: 'ws_quick_chat',
      name: 'Quick Chat',
      kind: 'quick-chat',
      status: 'active',
      defaults: {
        defaultModelId: null,
        defaultAgentId: null,
        defaultSkillIds: [],
      },
      counts: {
        threadCount: 0,
        artifactCount: 0,
        knowledgeEntryCount: 0,
      },
      createdAt: '2026-04-15T00:00:00Z',
      updatedAt: '2026-04-15T00:00:00Z',
    });

    expect(parsed.kind).toBe('quick-chat');
  });

  it('parses workspace resources separately from the workspace record', () => {
    const parsed = WorkspaceResourcesSchema.parse({
      knowledge: [],
      skills: [{ id: 'skill_protocol', name: 'Protocol Design', enabled: true }],
      agents: [
        {
          id: 'agent_planner',
          name: 'Planner',
          kind: 'planner',
          status: 'enabled',
          modelId: 'model_gpt_5_4',
          skillIds: ['skill_protocol'],
          profiles: [
            {
              id: 'default',
              displayName: 'Default Planning Profile',
              instructionsRef: null,
              modelId: null,
              skillIds: [],
              capabilityIds: [],
            },
          ],
          defaultProfileId: 'default',
          capabilities: [
            { id: 'turns', label: 'Turns', description: 'Can execute turn requests.' },
            { id: 'streaming', label: 'Streaming', description: null },
          ],
          sandboxSummary: {
            access: 'read-write',
            workspaceRootRefs: ['workspace'],
            summary: 'Workspace access is available.',
          },
          health: {
            status: 'ready',
            message: null,
            checkedAt: '2026-04-15T00:00:00Z',
          },
        },
      ],
      models: [{ id: 'model_gpt_5_4', name: 'GPT-5.4', enabled: true, isDefault: true }],
    });

    expect(parsed.agents).toHaveLength(1);
  });

  it('parses a codex-like thread summary', () => {
    const parsed = ThreadSchema.parse({
      id: 'th_demo',
      workspaceId: 'ws_demo',
      name: 'Protocol design review',
      preview: 'Update the protocol package to thin workspace payloads.',
      status: 'active',
      createdAt: '2026-04-15T00:00:00Z',
      updatedAt: '2026-04-15T00:00:00Z',
    });

    expect(parsed.preview).toContain('thin workspace payloads');
  });

  it('parses a codex-like turn with separately streamed items', () => {
    const parsed = TurnSchema.parse({
      id: 'tu_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      triggerActor: { kind: 'user', id: 'user_demo' },
      items: [],
      status: 'running',
      humanGate: null,
      error: null,
      configVersion: 7,
      startedAt: '2026-04-15T00:00:00Z',
      completedAt: null,
      durationMs: null,
    });

    expect(parsed.items).toEqual([]);
    expect(parsed.configVersion).toBe(7);
  });

  it('keeps the turn read projection strict and separate from durable Turn authority', () => {
    const turn = {
      id: 'tu_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      triggerActor: { kind: 'user', id: 'user_demo' },
      items: [],
      status: 'completed',
      humanGate: null,
      error: null,
      configVersion: 7,
      startedAt: '2026-04-15T00:00:00Z',
      completedAt: '2026-04-15T00:00:01Z',
      durationMs: 1_000,
    } as const;
    const contextPackageDigest = `ctxpkg_sha256_${'a'.repeat(64)}`;

    expect(TurnSchema.safeParse(turn).success).toBe(true);
    expect(TurnReadProjectionSchema.safeParse(turn).success).toBe(false);
    expect(
      TurnReadProjectionSchema.parse({
        ...turn,
        contextPackageDigest,
      })
    ).toMatchObject({ contextPackageDigest });
    expect(
      TurnReadProjectionSchema.parse({
        ...turn,
        contextPackageDigest: null,
      }).contextPackageDigest
    ).toBeNull();
    expect(
      TurnReadProjectionSchema.safeParse({
        ...turn,
        contextPackageDigest,
        undocumentedProjectionField: true,
      }).success
    ).toBe(false);
  });

  it('omits AgentSession identity from ordinary Turn projections while durable Turn retains it', () => {
    const turn = {
      id: 'tu_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      triggerActor: { kind: 'user', id: 'user_demo' },
      items: [],
      status: 'running' as const,
      humanGate: null,
      error: null,
      agentSessionId: 'as_demo',
      configVersion: null,
      startedAt: '2026-04-15T00:00:00Z',
      completedAt: null,
      durationMs: null,
    };

    expect(TurnSchema.parse(turn).agentSessionId).toBe('as_demo');
    const ordinaryTurn = ProductTurnSchema.parse(turn);
    expect(ordinaryTurn).not.toHaveProperty('agentSessionId');
    expect(
      JSON.stringify(
        TurnReadProjectionSchema.parse({
          ...ordinaryTurn,
          contextPackageDigest: null,
        })
      )
    ).not.toContain('agentSessionId');

    const malformedTurn = {
      ...turn,
      items: [
        {
          id: 'it_answer_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'tu_demo',
          status: 'completed' as const,
          createdAt: '2026-04-15T00:00:02Z',
          completedAt: '2026-04-15T00:00:03Z',
          type: 'user-input-response' as const,
          actor: { kind: 'user' as const, id: 'user_demo' },
          causationId: 'req_answer_demo',
          userInputRequestId: 'ui_demo',
          answers: { question: ['Answer'] },
        },
      ],
    };
    expect(TurnSchema.safeParse(malformedTurn).success).toBe(false);
    expect(ProductTurnSchema.safeParse(malformedTurn).success).toBe(false);
  });

  it('requires immutable source actors only on the three human-authored item variants', () => {
    const baseItem = {
      id: 'it_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      status: 'completed',
      createdAt: '2026-04-15T00:00:00Z',
      completedAt: '2026-04-15T00:00:01Z',
    } as const;
    const userActor = { kind: 'user', id: 'user_demo' } as const;
    const automationActor = {
      kind: 'automation',
      id: 'automation_demo',
      responsibleUserId: 'user_demo',
    } as const;

    expect(
      ItemSchema.safeParse({ ...baseItem, type: 'user-message', text: 'Hello.' }).success
    ).toBe(false);
    expect(
      ItemSchema.safeParse({
        ...baseItem,
        type: 'user-message',
        text: 'Hello.',
        actor: automationActor,
      }).success
    ).toBe(true);

    for (const item of [
      { ...baseItem, type: 'approval-decision', approvalRequestId: 'ap_demo', decision: 'granted' },
      {
        ...baseItem,
        type: 'user-input-response',
        userInputRequestId: 'ui_demo',
        answers: { question: ['Answer'] },
      },
    ] as const) {
      expect(ItemSchema.safeParse(item).success).toBe(false);
      expect(ItemSchema.safeParse({ ...item, actor: automationActor }).success).toBe(false);
      expect(ItemSchema.safeParse({ ...item, actor: userActor }).success).toBe(false);
      expect(ItemSchema.safeParse({ ...item, actor: userActor, causationId: '' }).success).toBe(
        false
      );
      expect(
        ItemSchema.safeParse({ ...item, actor: userActor, causationId: 'req_demo' }).success
      ).toBe(true);
    }
  });

  it('requires every user-input request to name the owning turn responsible user', () => {
    const requestItem = {
      id: 'it_question_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      status: 'completed',
      createdAt: '2026-04-15T00:00:00Z',
      completedAt: '2026-04-15T00:00:01Z',
      type: 'user-input-request',
      userInputRequestId: 'ui_demo',
      prompt: 'Choose.',
      questions: [
        {
          id: 'question',
          header: 'Choice',
          question: 'Which option?',
          options: null,
          isOther: true,
          isSecret: false,
        },
      ],
    } as const;
    const baseTurn = {
      id: 'tu_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      status: 'running',
      humanGate: null,
      error: null,
      configVersion: null,
      startedAt: '2026-04-15T00:00:00Z',
      completedAt: null,
      durationMs: null,
    } as const;
    const responseItem = {
      id: 'it_answer_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      status: 'completed',
      createdAt: '2026-04-15T00:00:02Z',
      completedAt: '2026-04-15T00:00:03Z',
      type: 'user-input-response',
      actor: { kind: 'user', id: 'user_demo' },
      causationId: 'req_answer_demo',
      userInputRequestId: 'ui_demo',
      answers: { question: ['Answer'] },
    } as const;

    expect(ItemSchema.safeParse(requestItem).success).toBe(false);
    expect(
      TurnSchema.safeParse({
        ...baseTurn,
        triggerActor: { kind: 'user', id: 'user_demo' },
        items: [{ ...requestItem, responsibleUserId: 'user_demo' }],
      }).success
    ).toBe(true);
    expect(
      TurnSchema.safeParse({
        ...baseTurn,
        triggerActor: {
          kind: 'automation',
          id: 'automation_demo',
          responsibleUserId: 'user_demo',
        },
        items: [{ ...requestItem, responsibleUserId: 'other_user' }],
      }).success
    ).toBe(false);
    expect(
      TurnSchema.safeParse({
        ...baseTurn,
        triggerActor: {
          kind: 'system',
          id: 'system_demo',
          responsibleUserId: null,
        },
        items: [{ ...requestItem, responsibleUserId: 'user_demo' }],
      }).success
    ).toBe(false);
    const request = { ...requestItem, responsibleUserId: 'user_demo' } as const;
    for (const items of [
      [request, { ...responseItem, actor: { kind: 'user', id: 'user_other' } }],
      [responseItem],
      [request, { ...request, id: 'it_question_duplicate' }, responseItem],
    ]) {
      expect(
        TurnSchema.safeParse({
          ...baseTurn,
          triggerActor: { kind: 'user', id: 'user_demo' },
          items,
        }).success
      ).toBe(false);
    }
  });

  it('rejects a turn without its immutable trigger actor', () => {
    expect(
      TurnSchema.safeParse({
        id: 'tu_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        items: [],
        status: 'running',
        humanGate: null,
        error: null,
        configVersion: null,
        startedAt: '2026-04-15T00:00:00Z',
        completedAt: null,
        durationMs: null,
      }).success
    ).toBe(false);
  });

  it('rejects turn records without an explicit nullable config version', () => {
    expect(() =>
      TurnSchema.parse({
        id: 'tu_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        items: [],
        status: 'running',
        humanGate: null,
        error: null,
        startedAt: '2026-04-15T00:00:00Z',
        completedAt: null,
        durationMs: null,
      })
    ).toThrow();
  });

  it('rejects command execution items without an explicit output snapshot', () => {
    expect(() =>
      ItemSchema.parse({
        id: 'it_cmd_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'tu_demo',
        status: 'completed',
        createdAt: '2026-04-15T00:00:00Z',
        completedAt: '2026-04-15T00:00:01Z',
        type: 'command-execution',
        command: 'pnpm test',
        cwd: '/workspace',
        exitCode: 0,
        durationMs: 100,
      })
    ).toThrow();

    const parsed = ItemSchema.parse({
      id: 'it_cmd_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      status: 'completed',
      createdAt: '2026-04-15T00:00:00Z',
      completedAt: '2026-04-15T00:00:01Z',
      type: 'command-execution',
      command: 'pnpm test',
      cwd: '/workspace',
      output: '',
      exitCode: 0,
      durationMs: 100,
    });

    expect(parsed.output).toBe('');
  });

  it('requires artifact-reference items to identify the exact artifact version', () => {
    const item = {
      id: 'it_artifact_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      status: 'completed',
      createdAt: '2026-04-15T00:00:00Z',
      completedAt: '2026-04-15T00:00:01Z',
      type: 'artifact-reference',
      artifactId: 'ar_demo',
      title: 'Artifact',
      summary: null,
    } as const;

    expect.soft(() => ItemSchema.parse(item)).toThrow();
    expect.soft(() => ItemSchema.parse({ ...item, artifactVersion: 2 })).toThrow();
    expect(
      ItemSchema.parse({
        ...item,
        artifactVersion: 2,
        lastMutationRequestId: 'req_artifact_communicate',
      })
    ).toMatchObject({
      artifactId: 'ar_demo',
      artifactVersion: 2,
      lastMutationRequestId: 'req_artifact_communicate',
    });
  });

  it('accepts an explicit user-input human gate for paused turns', () => {
    const gate = TurnHumanGateSchema.parse({
      kind: 'user-input',
      userInputRequestId: 'ui_demo',
      itemId: 'it_question_demo',
    });
    const parsed = TurnSchema.parse({
      id: 'tu_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      triggerActor: { kind: 'user', id: 'user_demo' },
      items: [],
      status: 'awaiting_human',
      humanGate: gate,
      error: null,
      configVersion: null,
      startedAt: '2026-04-15T00:00:00Z',
      completedAt: null,
      durationMs: null,
    });

    expect(parsed.humanGate?.kind).toBe('user-input');
  });

  it('requires humanGate only while a turn is awaiting a human', () => {
    expect(() =>
      TurnSchema.parse({
        id: 'tu_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        items: [],
        status: 'awaiting_human',
        humanGate: null,
        error: null,
        configVersion: null,
        startedAt: '2026-04-15T00:00:00Z',
        completedAt: null,
        durationMs: null,
      })
    ).toThrow();

    expect(() =>
      TurnSchema.parse({
        id: 'tu_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        items: [],
        status: 'running',
        humanGate: {
          kind: 'approval',
          approvalRequestId: 'ap_demo',
          itemId: 'it_approval_demo',
        },
        error: null,
        configVersion: null,
        startedAt: '2026-04-15T00:00:00Z',
        completedAt: null,
        durationMs: null,
      })
    ).toThrow();
  });

  it('rejects the removed approval-specific turn status', () => {
    expect(() =>
      TurnSchema.parse({
        id: 'tu_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        items: [],
        status: 'awaiting_approval',
        humanGate: null,
        error: null,
        configVersion: null,
        startedAt: '2026-04-15T00:00:00Z',
        completedAt: null,
        durationMs: null,
      })
    ).toThrow();
  });

  it('allows an empty assistant message while streaming deltas through item lifecycle events', () => {
    const parsed = ItemSchema.parse({
      id: 'it_assistant_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      type: 'assistant-message',
      status: 'in_progress',
      text: '',
      createdAt: '2026-04-15T00:00:00Z',
      completedAt: null,
    });

    expect(parsed.type).toBe('assistant-message');
  });

  it('parses item completion events with authoritative item snapshots', () => {
    const parsed = ServerEventSchema.parse({
      type: 'item-completed',
      itemId: 'it_assistant_demo',
      item: {
        id: 'it_assistant_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'tu_demo',
        type: 'assistant-message',
        status: 'completed',
        text: 'Final assistant payload.',
        createdAt: '2026-04-15T00:00:00Z',
        completedAt: '2026-04-15T00:00:01Z',
      },
    });

    expect(parsed.type).toBe('item-completed');
    expect(parsed.item.text).toBe('Final assistant payload.');
  });

  it('requires digest, mutation proof, and matching turn-output provenance for artifacts', () => {
    const contentDigest = `sha256:${'a'.repeat(64)}`;
    const artifact = {
      id: 'ar_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      kind: 'report',
      title: 'Protocol migration proposal',
      status: 'ready',
      summary: 'Summarizes the protocol restructuring and rollout plan.',
      version: 1,
      content: {
        format: 'markdown',
        body: '# Proposal',
      },
      contentDigest,
      lastMutationRequestId: 'req_artifact_create',
      origin: {
        kind: 'turn-output',
        threadId: 'th_demo',
        turnId: 'tu_demo',
        requestId: 'req_artifact_create',
      },
      createdAt: '2026-04-15T00:00:00Z',
      updatedAt: '2026-04-15T00:00:00Z',
    } as const;

    expect.soft(ArtifactSchema.parse(artifact)).toMatchObject({
      contentDigest,
      lastMutationRequestId: 'req_artifact_create',
      origin: artifact.origin,
    });
    expect
      .soft(ArtifactSchema.safeParse({ ...artifact, contentDigest: undefined }).success)
      .toBe(false);
    expect
      .soft(ArtifactSchema.safeParse({ ...artifact, lastMutationRequestId: undefined }).success)
      .toBe(false);
    for (const invalidDigest of [
      `sha256:${'A'.repeat(64)}`,
      `sha256:${'a'.repeat(63)}`,
      'a'.repeat(64),
    ]) {
      expect
        .soft(ArtifactSchema.safeParse({ ...artifact, contentDigest: invalidDigest }).success)
        .toBe(false);
    }
    for (const field of Object.keys(artifact.origin)) {
      const origin: Record<string, unknown> = { ...artifact.origin };
      delete origin[field];
      expect.soft(ArtifactSchema.safeParse({ ...artifact, origin }).success).toBe(false);
    }
    for (const mismatch of [{ threadId: 'th_other' }, { turnId: 'tu_other' }]) {
      expect.soft(ArtifactSchema.safeParse({ ...artifact, ...mismatch }).success).toBe(false);
    }

    const importedDigest = `sha256:${'b'.repeat(64)}`;
    const importedOrigin = {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: 'req_artifact_import',
      sourceDigest: importedDigest,
      actor: {
        kind: 'user',
        id: 'usr_demo',
      },
      requestId: 'req_artifact_import',
      recordedAt: '2026-04-15T00:00:00Z',
    } as const;
    const importedArtifact = {
      ...artifact,
      id: 'ar_imported_demo',
      threadId: null,
      turnId: null,
      kind: 'file',
      title: 'Imported material',
      summary: null,
      content: {
        format: 'text',
        body: 'Imported material',
      },
      contentDigest: importedDigest,
      lastMutationRequestId: 'req_artifact_import',
      origin: importedOrigin,
    } as const;

    expect.soft(ArtifactSchema.parse(importedArtifact)).toMatchObject({ origin: importedOrigin });
    for (const field of Object.keys(importedOrigin)) {
      const origin: Record<string, unknown> = { ...importedOrigin };
      delete origin[field];
      expect.soft(ArtifactSchema.safeParse({ ...importedArtifact, origin }).success).toBe(false);
    }
    for (const invalid of [
      { ...importedArtifact, threadId: 'th_demo' },
      { ...importedArtifact, turnId: 'tu_demo' },
      { ...importedArtifact, origin: { ...importedOrigin, sourceKind: 'registered' } },
      { ...importedArtifact, origin: { ...importedOrigin, sourceId: 'req_other' } },
      { ...importedArtifact, origin: { ...importedOrigin, actorId: 'usr_demo' } },
      {
        ...importedArtifact,
        origin: { ...importedOrigin, sourceDigest: `sha256:${'c'.repeat(64)}` },
      },
    ]) {
      expect.soft(ArtifactSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('parses a command-execution item aligned with codex CommandExecution', () => {
    const parsed = ItemSchema.parse({
      id: 'it_cmd_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      type: 'command-execution',
      status: 'completed',
      command: 'pnpm test',
      cwd: '/workspace',
      output: '',
      exitCode: 0,
      durationMs: 1234,
      createdAt: '2026-04-15T00:00:00Z',
      completedAt: '2026-04-15T00:00:01Z',
    });

    expect(parsed.type).toBe('command-execution');
  });

  it('parses approval request and decision items', () => {
    const approvalRequest = ItemSchema.parse({
      id: 'it_approval_request_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: 'ap_demo',
      title: 'Approve command',
      description: 'Run `pnpm test`.',
      kind: 'permission',
      createdAt: '2026-04-15T00:00:00Z',
      completedAt: '2026-04-15T00:00:00Z',
    });
    const approvalDecision = ItemSchema.parse({
      id: 'it_approval_decision_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      type: 'approval-decision',
      status: 'completed',
      actor: { kind: 'user', id: 'user_demo' },
      causationId: 'req_approval_decision_demo',
      approvalRequestId: 'ap_demo',
      decision: 'granted',
      createdAt: '2026-04-15T00:00:01Z',
      completedAt: '2026-04-15T00:00:01Z',
    });

    expect(approvalRequest.type).toBe('approval-request');
    expect(approvalDecision.type).toBe('approval-decision');
  });

  it('parses user input request and response items', () => {
    const userInputRequest = ItemSchema.parse({
      id: 'it_user_input_request_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: 'user_demo',
      userInputRequestId: 'question_item_1',
      prompt: 'Which branch should I use?',
      questions: [
        {
          id: 'branch',
          header: 'Branch',
          question: 'Which branch should I use?',
          options: [
            {
              label: 'main',
              description: 'Use the main branch.',
            },
          ],
          isOther: false,
          isSecret: false,
        },
      ],
      createdAt: '2026-04-15T00:00:00Z',
      completedAt: '2026-04-15T00:00:00Z',
    });
    const userInputResponse = ItemSchema.parse({
      id: 'it_user_input_response_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      type: 'user-input-response',
      status: 'completed',
      actor: { kind: 'user', id: 'user_demo' },
      causationId: 'req_user_input_response_demo',
      userInputRequestId: 'question_item_1',
      answers: {
        branch: ['main'],
      },
      createdAt: '2026-04-15T00:00:01Z',
      completedAt: '2026-04-15T00:00:01Z',
    });

    expect(userInputRequest.type).toBe('user-input-request');
    expect(userInputResponse.type).toBe('user-input-response');
    expect(() =>
      ItemSchema.parse({
        ...userInputResponse,
        answers: { branch: ['main', 'release'] },
      })
    ).toThrow();
  });

  it('parses a tool-call item aligned with codex McpToolCall', () => {
    const parsed = ItemSchema.parse({
      id: 'it_tool_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      type: 'tool-call',
      status: 'completed',
      tool: 'read_file',
      server: 'filesystem-server',
      arguments: { path: '/src/index.ts' },
      result: 'file contents...',
      error: null,
      durationMs: 50,
      createdAt: '2026-04-15T00:00:00Z',
      completedAt: '2026-04-15T00:00:00Z',
    });

    expect(parsed.type).toBe('tool-call');
  });

  it('parses an agent-handoff item', () => {
    const parsed = ItemSchema.parse({
      id: 'it_handoff_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      type: 'agent-handoff',
      status: 'completed',
      fromAgentId: 'agent_planner',
      toAgentId: 'agent_coder',
      reason: 'Implementation ready',
      createdAt: '2026-04-15T00:00:00Z',
      completedAt: '2026-04-15T00:00:00Z',
    });

    expect(parsed.type).toBe('agent-handoff');
  });

  it('parses stable Codex and OpenCode agent catalog summaries', () => {
    const resources = WorkspaceResourcesSchema.parse({
      knowledge: [],
      skills: [],
      agents: [
        {
          id: 'agent_codex_host',
          name: 'Codex Host Agent',
          kind: 'coder',
          status: 'enabled',
          modelId: 'model_codex',
          skillIds: [],
          profiles: [
            {
              id: 'default',
              displayName: 'Default Coding Profile',
              instructionsRef: null,
              modelId: null,
              skillIds: [],
              capabilityIds: [],
            },
          ],
          defaultProfileId: 'default',
          capabilities: [
            { id: 'turns', label: 'Turns', description: 'Can execute turn requests.' },
            { id: 'streaming', label: 'Streaming', description: null },
            { id: 'interrupts', label: 'Interrupts', description: null },
          ],
          sandboxSummary: {
            access: 'read-write',
            workspaceRootRefs: ['repo'],
            summary: 'Repo access is available.',
          },
          health: {
            status: 'ready',
            message: null,
            checkedAt: '2026-05-05T00:00:00Z',
          },
        },
        {
          id: 'agent_opencode_host',
          name: 'OpenCode Host Agent',
          kind: 'coder',
          status: 'enabled',
          modelId: 'model_opencode',
          skillIds: [],
          profiles: [
            {
              id: 'default',
              displayName: 'Default Coding Profile',
              instructionsRef: null,
              modelId: null,
              skillIds: [],
              capabilityIds: [],
            },
          ],
          defaultProfileId: 'default',
          capabilities: [
            { id: 'turns', label: 'Turns', description: 'Can execute turn requests.' },
            { id: 'streaming', label: 'Streaming', description: null },
          ],
          sandboxSummary: {
            access: 'read-write',
            workspaceRootRefs: ['repo'],
            summary: 'Repo access is available.',
          },
          health: {
            status: 'unknown',
            message: 'Not checked yet',
            checkedAt: null,
          },
        },
      ],
      models: [
        { id: 'model_codex', name: 'Codex', enabled: true, isDefault: true },
        { id: 'model_opencode', name: 'OpenCode', enabled: true, isDefault: false },
      ],
    });

    expect(
      resources.agents.map((agent) => agent.capabilities.map((capability) => capability.id))
    ).toEqual([
      ['turns', 'streaming', 'interrupts'],
      ['turns', 'streaming'],
    ]);
  });

  it('parses AgentSessions with nullable sandbox summaries', () => {
    const parsed = AgentSessionSchema.parse({
      id: 'session_demo',
      agentId: 'agent_codex_host',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      status: 'ready',
      message: null,
      sandboxSummary: null,
      createdAt: '2026-04-15T00:00:00Z',
      updatedAt: '2026-04-15T00:00:00Z',
    });

    expect(parsed.sandboxSummary).toBeNull();
  });

  it('rejects invalid SSE event names', () => {
    expect(() => SseEventNameSchema.parse('invalid.event')).toThrow();
  });

  it('accepts a thread-updated event in the SSE envelope', () => {
    const parsed = SseEventEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      event: 'thread.updated',
      sequence: 2,
      requestId: '0190f4c8-0000-7000-8000-000000000204',
      timestamp: '2026-04-15T00:00:00Z',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      data: {
        type: 'thread-updated',
        thread: {
          id: 'th_demo',
          workspaceId: 'ws_demo',
          name: 'Updated thread',
          preview: 'Some preview',
          status: 'active',
          createdAt: '2026-04-15T00:00:00Z',
          updatedAt: '2026-04-15T00:00:01Z',
        },
      },
    });

    expect(parsed.data.type).toBe('thread-updated');
  });

  it('requires request ids on thin mutating thread and turn commands', () => {
    expect(() =>
      UpdateThreadRequestSchema.parse({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        name: 'Updated thread',
      })
    ).toThrow();
    expect(() =>
      ArchiveThreadRequestSchema.parse({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
      })
    ).toThrow();
    expect(() =>
      CancelTurnRequestSchema.parse({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'tu_demo',
      })
    ).toThrow();
    const parsed = UpdateThreadRequestSchema.parse({
      requestId: '0190f4c8-0000-7000-8000-000000000205',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      name: 'Updated thread',
    });

    expect(parsed.name).toBe('Updated thread');
  });

  it('accepts AgentSession update events', () => {
    const parsed = AgentSessionUpdatedEventSchema.parse({
      type: 'agent-session-updated',
      agentSession: {
        id: 'session_demo',
        agentId: 'agent_codex_host',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        status: 'busy',
        message: null,
        createdAt: '2026-04-15T00:00:00Z',
        updatedAt: '2026-04-15T00:00:01Z',
      },
    });

    expect(parsed.agentSession.status).toBe('busy');
  });

  it('validates workspace kind as a closed enum in update requests', () => {
    const parsed = UpdateWorkspaceRequestSchema.parse({
      requestId: '0190f4c8-0000-7000-8000-000000000126',
      kind: 'research',
    });

    expect(parsed.kind).toBe('research');
    expect(() =>
      UpdateWorkspaceRequestSchema.parse({
        requestId: '0190f4c8-0000-7000-8000-000000000126',
        kind: 'invalid',
      })
    ).toThrow();
  });

  it('uses name (not title) for thread creation aligned with ThreadSchema', () => {
    const parsed = CreateThreadRequestSchema.parse({
      requestId: '0190f4c8-0000-7000-8000-000000000127',
      workspaceId: 'ws_demo',
      name: 'My new thread',
    });

    expect(parsed.name).toBe('My new thread');
  });

  it('parses paginated thread listing response', () => {
    const parsed = ListThreadsResponseSchema.parse({
      items: [
        {
          id: 'th_1',
          workspaceId: 'ws_demo',
          name: 'Thread one',
          preview: 'First thread',
          status: 'active',
          createdAt: '2026-04-15T00:00:00Z',
          updatedAt: '2026-04-15T00:00:00Z',
        },
      ],
      nextCursor: 'cursor_abc',
    });

    expect(parsed.items).toHaveLength(1);
    expect(parsed.nextCursor).toBe('cursor_abc');
  });

  it('parses a bare thread detail response', () => {
    const parsed = GetThreadResponseSchema.parse({
      id: 'th_demo',
      workspaceId: 'ws_demo',
      name: null,
      preview: 'Preview text',
      status: 'active',
      createdAt: '2026-04-15T00:00:00Z',
      updatedAt: '2026-04-15T00:00:00Z',
    });

    expect(parsed.id).toBe('th_demo');
  });

  it('parses a bare turn submission response', () => {
    const parsed = TurnSchema.parse({
      id: 'tu_new',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      triggerActor: { kind: 'user', id: 'user_demo' },
      items: [],
      status: 'running',
      humanGate: null,
      error: null,
      configVersion: null,
      startedAt: '2026-04-15T00:00:00Z',
      completedAt: null,
      durationMs: null,
    });

    expect(parsed.status).toBe('running');
  });

  it('parses an artifact listing response without a cursor', () => {
    const parsed = ListArtifactsResponseSchema.parse({
      items: [],
    });

    expect(parsed.items).toEqual([]);
    expect(parsed.nextCursor).toBeUndefined();
  });

  it('parses a thread listing response without a cursor', () => {
    const parsed = ListThreadsResponseSchema.parse({
      items: [],
    });

    expect(parsed.items).toEqual([]);
    expect(parsed.nextCursor).toBeUndefined();
  });

  it('parses a bare artifact detail response', () => {
    const parsed = GetArtifactResponseSchema.parse({
      id: 'ar_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      kind: 'report',
      title: 'Protocol report',
      status: 'ready',
      summary: 'Summary',
      version: 1,
      content: {
        format: 'markdown',
        body: '# Report',
      },
      contentDigest: `sha256:${'a'.repeat(64)}`,
      lastMutationRequestId: 'req_artifact_create',
      origin: {
        kind: 'turn-output',
        threadId: 'th_demo',
        turnId: 'tu_demo',
        requestId: 'req_artifact_create',
      },
      createdAt: '2026-04-15T00:00:00Z',
      updatedAt: '2026-04-15T00:00:00Z',
    });

    expect(parsed.id).toBe('ar_demo');
  });
});
