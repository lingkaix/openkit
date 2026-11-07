import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { TITLE_MAX_CODE_POINTS } from '../llm/title-generation.js';
import { operationRequest } from '../test-support/operation-request.js';
import {
  awaitTerminalTitles,
  closeInstallations,
  isTitleRequest,
  openTitleInstallation,
  type TitleInstallation,
} from '../test-support/p2-oracle-fixture.js';

const open: TitleInstallation[] = [];

afterEach(() => closeInstallations(open));

describe('local title sanitizer through the producer', () => {
  it('stores one sanitized title from the model text', async () => {
    const installation = await openRaw('<think>secret</think>Title: **"Hello, world!"**');
    const threadId = await createGoal(installation, 'Initial pipeline intent');
    expect(await threadName(installation, threadId)).toBe('Hello, world');
    expect(titleHits(installation)).toHaveLength(1);
  });

  it('keeps the initial title when sanitizing leaves it empty', async () => {
    const intent = 'Initial empty title intent';
    const installation = await openRaw('<think>hidden</think>');
    const threadId = await createGoal(installation, intent);
    expect(await threadName(installation, threadId)).toBe(intent);
    const calls = await awaitTerminalTitles(installation);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('succeeded');
  });

  it('keeps the initial title when the sanitized result exceeds 80 code points', async () => {
    const intent = 'Initial long title intent';
    const installation = await openRaw('A'.repeat(TITLE_MAX_CODE_POINTS + 1));
    const threadId = await createGoal(installation, intent);
    expect(await threadName(installation, threadId)).toBe(intent);
    expect(titleHits(installation)).toHaveLength(1);
  });

  it('stores SQLITE_BUSY with its underscore', async () => {
    const installation = await openRaw('Fix SQLITE_BUSY');
    const threadId = await createGoal(installation, 'Initial busy intent');
    expect(await threadName(installation, threadId)).toBe('Fix SQLITE_BUSY');
    expect(titleHits(installation)).toHaveLength(1);
  });

  it('stores a slug that passes the cap without a second call', async () => {
    const installation = await openRaw('GatewayConfiguration_tsx');
    const threadId = await createGoal(installation, 'Initial slug intent');
    expect(await threadName(installation, threadId)).toBe('GatewayConfiguration_tsx');
    expect(titleHits(installation)).toHaveLength(1);
    const calls = await awaitTerminalTitles(installation);
    expect(calls).toHaveLength(1);
  });
});

async function openRaw(content: string): Promise<TitleInstallation> {
  const installation = await openTitleInstallation({
    decide: () => ({ kind: 'sse', answer: { content } }),
  });
  open.push(installation);
  return installation;
}

async function createGoal(installation: TitleInstallation, intent: string): Promise<string> {
  const response = await installation.app.request(
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
  expect(response.status, await response.clone().text()).toBe(200);
  const view = (await response.json()) as { goal: { threadId: string } };
  await awaitTerminalTitles(installation);
  return view.goal.threadId;
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

function titleHits(installation: TitleInstallation): unknown[] {
  return installation.peer.hits.filter((hit) => isTitleRequest(hit.body));
}
