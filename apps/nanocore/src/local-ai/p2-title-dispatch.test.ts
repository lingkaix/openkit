import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { TITLE_DEADLINE_MS, TITLE_INPUT_CODE_POINTS } from '../llm/title-generation.js';
import { operationRequest } from '../test-support/operation-request.js';
import {
  awaitTerminalTitles,
  closeInstallations,
  isTitleRequest,
  openTitleInstallation,
  type TitleAnswer,
  type TitleInstallation,
} from '../test-support/p2-oracle-fixture.js';
import { LOCAL_LLM_DEFAULT_MODEL_ID, LOCAL_LLM_PROFILE_ID } from './profiles.js';

const open: TitleInstallation[] = [];

afterEach(() => closeInstallations(open));

describe('local title dispatch', () => {
  it('returns the goal create response while the title peer is still held', async () => {
    const installation = await openHeld();
    const responsePromise = createGoal(installation, 'Draft the release notes for the gateway');
    const held = await installation.peer.held;
    const winner = await Promise.race([
      responsePromise.then((response) => ({ kind: 'create' as const, response })),
      held.aborted.then(() => ({ kind: 'aborted' as const })),
    ]);
    expect(winner.kind).toBe('create');
    if (winner.kind !== 'create') return;
    expect(winner.response.status, await winner.response.clone().text()).toBe(200);
    held.release({ content: 'Draft gateway release notes' });
    const calls = await awaitTerminalTitles(installation);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: 'succeeded', operation: 'llm.title_generation' });
  });

  it('sends at most 500 code points, temperature 0, and a 32 token cap', async () => {
    const installation = await openAnswer({ content: 'Capped title' });
    const source = `${'A'.repeat(TITLE_INPUT_CODE_POINTS)}TAIL-NOT-SENT`;
    const response = await createGoal(installation, source);
    expect(response.status, await response.clone().text()).toBe(200);
    await awaitTerminalTitles(installation);
    const titles = installation.peer.hits.filter((hit) => isTitleRequest(hit.body));
    expect(titles).toHaveLength(1);
    const body = titles[0]?.body as {
      model?: string;
      temperature?: number;
      max_tokens?: number;
      max_completion_tokens?: number;
      cache_prompt?: unknown;
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    const user = body.messages?.find((message) => message.role === 'user');
    const content =
      typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
    expect(content).toContain('A'.repeat(TITLE_INPUT_CODE_POINTS));
    expect(content).not.toContain('TAIL-NOT-SENT');
    expect([...content].filter((character) => character === 'A')).toHaveLength(
      TITLE_INPUT_CODE_POINTS
    );
    expect(body.model).toBe(LOCAL_LLM_DEFAULT_MODEL_ID);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(32);
    expect(body).not.toHaveProperty('cache_prompt');
  });

  it('records measured usage, one attempt, and one succeeded finish', async () => {
    const installation = await openAnswer({
      content: 'Draft gateway release notes',
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
    const response = await createGoal(installation, 'Draft the release notes for the gateway');
    expect(response.status, await response.clone().text()).toBe(200);
    const view = (await response.json()) as { goal: { threadId: string } };
    const calls = await awaitTerminalTitles(installation);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call).toMatchObject({
      operation: 'llm.title_generation',
      family: 'llm',
      status: 'succeeded',
      providerRef: 'titles',
      threadId: view.goal.threadId,
    });
    expect(lineage(call)).toMatchObject({
      logicalModelId: 'titles',
      entries: [
        expect.objectContaining({
          kind: 'attempt',
          routeMemberId: 'local',
          providerProfileId: LOCAL_LLM_PROFILE_ID,
          terminalResult: 'succeeded',
        }),
      ],
    });
    expect(attemptEntries(call)).toHaveLength(1);
    const rows = installation.ledger().usage.filter((row) => row.capabilityCallId === call.id);
    expect(rows.map(usageShape).sort(bySource)).toEqual(
      [
        {
          capabilityCallId: call.id,
          modelId: 'titles',
          providerRef: LOCAL_LLM_PROFILE_ID,
          providerModel: LOCAL_LLM_DEFAULT_MODEL_ID,
          quantity: 0,
          source: 'llm-gateway-adapter-reported:cache_read',
          unit: 'tokens',
        },
        {
          capabilityCallId: call.id,
          modelId: 'titles',
          providerRef: LOCAL_LLM_PROFILE_ID,
          providerModel: LOCAL_LLM_DEFAULT_MODEL_ID,
          quantity: 0,
          source: 'llm-gateway-adapter-reported:cache_write',
          unit: 'tokens',
        },
        {
          capabilityCallId: call.id,
          modelId: 'titles',
          providerRef: LOCAL_LLM_PROFILE_ID,
          providerModel: LOCAL_LLM_DEFAULT_MODEL_ID,
          quantity: 11,
          source: 'llm-gateway-adapter-reported:input',
          unit: 'tokens',
        },
        {
          capabilityCallId: call.id,
          modelId: 'titles',
          providerRef: LOCAL_LLM_PROFILE_ID,
          providerModel: LOCAL_LLM_DEFAULT_MODEL_ID,
          quantity: 7,
          source: 'llm-gateway-adapter-reported:output',
          unit: 'tokens',
        },
      ].sort(bySource)
    );
    expect(await threadName(installation, view.goal.threadId)).toBe('Draft gateway release notes');
  });

  it('records one failed finish and no usage when the provider returns 500', async () => {
    const installation = await openTitleInstallation({
      decide: () => ({ kind: 'status', status: 500, body: { error: { message: 'boom' } } }),
    });
    open.push(installation);
    const intent = 'Keep the initial goal title';
    const response = await createGoal(installation, intent);
    expect(response.status, await response.clone().text()).toBe(200);
    const view = (await response.json()) as { goal: { threadId: string } };
    const calls = await awaitTerminalTitles(installation);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: 'failed', operation: 'llm.title_generation' });
    expect(attemptEntries(calls[0])).toHaveLength(1);
    expect(
      installation.ledger().usage.filter((row) => row.capabilityCallId === calls[0]?.id)
    ).toEqual([]);
    expect(installation.peer.hits.filter((hit) => isTitleRequest(hit.body))).toHaveLength(1);
    expect(await threadName(installation, view.goal.threadId)).toBe(intent);
  });

  it(
    'records one timed-out finish when the deadline aborts the title transport',
    async () => {
      const installation = await openHeld();
      const pending = createGoal(installation, 'Wait for the title deadline');
      const held = await installation.peer.held;
      const response = await pending;
      expect(response.status, await response.clone().text()).toBe(200);
      await held.aborted;
      const calls = await awaitTerminalTitles(installation);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.status).toBe('timed-out');
      expect(
        installation.ledger().usage.filter((row) => row.capabilityCallId === calls[0]?.id)
      ).toEqual([]);
      expect(installation.peer.hits.filter((hit) => isTitleRequest(hit.body))).toHaveLength(1);
      expect(attemptEntries(calls[0])).toHaveLength(1);
    },
    TITLE_DEADLINE_MS + 20_000
  );

  it(
    'aborts the in-flight title fetch when llama is disabled',
    async () => {
      const installation = await openHeld();
      const pending = createGoal(installation, 'Cancel the title call');
      const held = await installation.peer.held;
      const disabled = await installation.app.request(
        ...operationRequest('local-ai.disable', { backendId: 'llama-cpp' })
      );
      expect(disabled.status, await disabled.clone().text()).toBe(200);
      await held.aborted;
      const calls = await awaitTerminalTitles(installation);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.status).toBe('aborted');
      expect(installation.peer.hits.filter((hit) => isTitleRequest(hit.body))).toHaveLength(1);
      await pending;
    },
    TITLE_DEADLINE_MS + 20_000
  );
});

function openHeld(): Promise<TitleInstallation> {
  return remember(openTitleInstallation({ decide: () => ({ kind: 'hold' }) }));
}

function openAnswer(answer: TitleAnswer): Promise<TitleInstallation> {
  return remember(
    openTitleInstallation({
      decide: () => ({ kind: 'sse', answer }),
    })
  );
}

async function remember(pending: Promise<TitleInstallation>): Promise<TitleInstallation> {
  const installation = await pending;
  open.push(installation);
  return installation;
}

function createGoal(installation: TitleInstallation, intent: string): Promise<Response> {
  return installation.app.request(
    ...operationRequest(
      'goal.create',
      { workspaceId: installation.workspaceId },
      {
        body: JSON.stringify({
          workspaceId: installation.workspaceId,
          requestId: randomUUID(),
          intent,
        }),
      }
    )
  );
}

async function threadName(installation: TitleInstallation, threadId: string): Promise<string> {
  const response = await installation.app.request(
    ...operationRequest('thread.read', {
      workspaceId: installation.workspaceId,
      threadId,
    })
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { name: string }).name;
}

function lineage(
  call: { extensions?: { 'openkit.gateway/routeLineage'?: unknown } } | undefined
): unknown {
  return call?.extensions?.['openkit.gateway/routeLineage'];
}

function attemptEntries(
  call:
    | {
        extensions?: {
          'openkit.gateway/routeLineage'?: { entries?: readonly unknown[] };
        };
      }
    | undefined
): readonly unknown[] {
  return call?.extensions?.['openkit.gateway/routeLineage']?.entries ?? [];
}

function usageShape(row: ReturnType<TitleInstallation['ledger']>['usage'][number]) {
  return {
    capabilityCallId: row.capabilityCallId,
    modelId: row.modelId,
    providerRef: row.providerRef,
    providerModel: row.providerModel,
    quantity: row.quantity,
    source: row.source,
    unit: row.unit,
  };
}

function bySource(left: { source: string }, right: { source: string }): number {
  return left.source.localeCompare(right.source);
}
