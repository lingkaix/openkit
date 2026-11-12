import type { HumanAttentionSource } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { lintTimelineNotices, timelineNotices } from './notices';
import {
  hrefOf,
  type ObjectRef,
  type ResolveFacts,
  referenceTitle,
  resolve,
  versionFactKey,
} from './resolve';

const WS = 'ws_1';
const THREAD = 'th_1';
const TURN = 'tu_1';

function threads(present: boolean, activity: 'chat' | 'task' | 'goal' = 'task'): ResolveFacts {
  const map = new Map<
    string,
    { activity: 'chat' | 'task' | 'goal' | 'unknown'; name: string | null }
  >();
  if (present) map.set(THREAD, { activity, name: 'Launch notes' });
  return { threads: map };
}

function source(value: Record<string, unknown>): HumanAttentionSource {
  return value as HumanAttentionSource;
}

describe('timeline object resolver', () => {
  it('lints the reference sentences', () => {
    expect(lintTimelineNotices()).toEqual([]);
  });

  it('resolves every kind or returns an unavailable reason', () => {
    const facts: ResolveFacts = {
      threads: new Map([[THREAD, { activity: 'task', name: 'Launch notes' }]]),
      versions: new Map([[versionFactKey('art_1', 3), { available: true }]]),
    };
    const refs: ObjectRef[] = [
      { kind: 'thread', workspaceId: WS, threadId: THREAD, turnId: TURN },
      { kind: 'artifact', workspaceId: WS, artifactId: 'art_1', version: 3 },
      { kind: 'audit', workspaceId: WS, scope: { turnId: TURN } },
      { kind: 'audit', workspaceId: WS, scope: { capabilityCallId: 'call_1' } },
      { kind: 'audit', workspaceId: WS, scope: { itemId: 'it_1' } },
      {
        kind: 'attention',
        workspaceId: WS,
        rowId: 'row_1',
        source: source({
          type: 'approval',
          approvalRequestId: 'ap_1',
          workspaceId: WS,
          threadId: THREAD,
          turnId: TURN,
        }),
      },
      { kind: 'knowledge', workspaceId: WS, pageId: 'page_1', revision: 'rev_1' },
      { kind: 'material', workspaceId: WS, threadId: THREAD, materialId: 'mat_1' },
      { kind: 'connection', workspaceId: WS, connectionRef: 'github' },
      { kind: 'gateway', logicalModelId: 'model_1' },
      { kind: 'environment', workspaceId: WS, turnId: TURN },
      { kind: 'goal-card', workspaceId: WS, threadId: THREAD, cardId: 'card_1' },
    ];
    for (const ref of refs) {
      const result = resolve(ref, facts);
      if ('unavailable' in result) expect(result.unavailable.length).toBeGreaterThan(0);
      else expect(result.path.startsWith('/')).toBe(true);
    }
  });

  it('opens a message on its item and a request on the run', () => {
    const message = resolve(
      {
        kind: 'thread',
        workspaceId: WS,
        threadId: THREAD,
        turnId: TURN,
        itemId: 'it_1',
        requestId: 'req_1',
      },
      threads(true)
    );
    expect(message).toMatchObject({
      path: `/tasks/${WS}/${THREAD}`,
      focus: 'it_1',
      notice: null,
    });
    expect(hrefOf(message)).toContain('item=it_1');
    expect(hrefOf(message)).toContain('turn=tu_1');
    expect(hrefOf(message)).not.toContain('request');

    const request = resolve(
      {
        kind: 'thread',
        workspaceId: WS,
        threadId: THREAD,
        turnId: TURN,
        requestId: 'req_1',
      },
      threads(true)
    );
    expect(request).toMatchObject({
      focus: TURN,
      notice: timelineNotices.opensRunNotRequest,
    });
    expect(hrefOf(request)).toContain('request=req_1');
    expect(hrefOf(request)).not.toContain('item=');
  });

  it('shows no title when the viewer cannot open the source', () => {
    const result = resolve(
      { kind: 'thread', workspaceId: WS, threadId: THREAD, turnId: TURN },
      threads(false)
    );
    expect(result).toEqual({ unavailable: timelineNotices.sourceNotAvailable });
    expect(referenceTitle(result, 'Launch notes')).toBeNull();
    expect(hrefOf(result)).toBeNull();
    expect(JSON.stringify(result)).not.toContain('Launch notes');
  });

  it('does not deny a thread when the audience read was not supplied', () => {
    const result = resolve({ kind: 'thread', workspaceId: WS, threadId: THREAD, turnId: TURN });
    expect(hrefOf(result)).toBe(`/chat/${WS}/${THREAD}?turn=${TURN}&turnId=${TURN}`);
  });

  it('pins an exact artifact version and never substitutes another', () => {
    const pinned = resolve(
      { kind: 'artifact', workspaceId: WS, artifactId: 'art_1', version: 3 },
      { versions: new Map([[versionFactKey('art_1', 3), { available: true }]]) }
    );
    expect(hrefOf(pinned)).toBe(`/artifacts?workspaceId=${WS}&artifact=art_1&version=3`);
    expect(pinned).toMatchObject({ focus: 'version-3' });
    const missing = resolve(
      { kind: 'artifact', workspaceId: WS, artifactId: 'art_1', version: 3 },
      {
        versions: new Map([
          [versionFactKey('art_1', 3), { available: false }],
          [versionFactKey('art_1', 4), { available: true }],
        ]),
      }
    );
    expect(missing).toMatchObject({
      unavailable: 'Version 3 unavailable',
      fallback: { label: timelineNotices.openVersionList },
    });
    expect(hrefOf(missing)).toBe(`/artifacts?workspaceId=${WS}&artifact=art_1`);
    expect(hrefOf(missing)).not.toContain('version=');
  });

  it('opens usage and audit without a filter', () => {
    const result = resolve({ kind: 'audit', workspaceId: WS, scope: { turnId: TURN } });
    expect(result).toEqual({
      path: '/workspace/usage',
      search: '',
      focus: null,
      notice: 'Opens Usage & audit (not filtered)',
    });
  });

  it('resolves an attention row from its own source', () => {
    const review = resolve(
      {
        kind: 'attention',
        workspaceId: WS,
        rowId: 'artifact-review:rev',
        source: source({
          type: 'artifact_review',
          reviewId: 'rev',
          artifactId: 'art_1',
          artifactVersion: 3,
          workspaceId: WS,
          threadId: THREAD,
          turnId: TURN,
        }),
      },
      threads(true)
    );
    expect(hrefOf(review)).toBe(`/goals/${WS}/${THREAD}/artifacts/art_1`);
    const recovery = resolve({
      kind: 'attention',
      workspaceId: WS,
      rowId: 'workspace_recovery:1',
      source: source({
        type: 'workspace_recovery',
        workspaceId: WS,
        reconciliationRecordId: 'wrr_1',
        triggerReason: 'restart',
        stateAfter: 'requires-human',
        affectedRecordIds: ['rec_1'],
        evidenceBundleIds: ['ev_1'],
        requiredHumanDecision: null,
      }),
    });
    expect(hrefOf(recovery)).toBe('/workspace-changes?recovery=wrr_1');
    expect(recovery).toMatchObject({ focus: 'recovery-wrr_1', notice: null });
    const knowledge = resolve({
      kind: 'attention',
      workspaceId: WS,
      rowId: 'knowledge:1',
      source: source({ type: 'knowledge', workspaceId: WS }),
    });
    expect(knowledge).toMatchObject({
      path: '/knowledge',
      notice: timelineNotices.opensKnowledge,
    });
    const denied = resolve(
      {
        kind: 'attention',
        workspaceId: WS,
        rowId: 'approval:1',
        threadId: THREAD,
        turnId: TURN,
        source: source({
          type: 'approval',
          approvalRequestId: 'ap_1',
          workspaceId: WS,
          threadId: THREAD,
          turnId: TURN,
        }),
      },
      threads(false)
    );
    expect(referenceTitle(denied, 'Secret thread')).toBeNull();
  });

  it('degrades extended surfaces without a dead link', () => {
    expect(resolve({ kind: 'connection', workspaceId: WS, connectionRef: 'github' })).toEqual({
      unavailable: timelineNotices.connectionUnavailable,
    });
    expect(
      hrefOf(resolve({ kind: 'connection', workspaceId: WS, connectionRef: 'github' }))
    ).toBeNull();
    expect(resolve({ kind: 'environment', workspaceId: WS, turnId: TURN })).toEqual({
      unavailable: timelineNotices.inspectorOnly,
    });
    expect(resolve({ kind: 'gateway', logicalModelId: 'model_1' })).toMatchObject({
      path: '/settings/gateway',
      search: 'model=model_1',
      focus: 'gateway-model-model_1',
      notice: null,
    });
    expect(hrefOf(resolve({ kind: 'gateway', logicalModelId: 'model_1' }))).toBe(
      '/settings/gateway?model=model_1'
    );
    expect(resolve({ kind: 'gateway' })).toMatchObject({
      path: '/settings/gateway',
      search: '',
      notice: null,
    });
    expect(
      resolve({ kind: 'knowledge', workspaceId: WS, pageId: 'page_1', revision: '9' })
    ).toMatchObject({
      path: '/knowledge',
      search: '',
      notice: timelineNotices.opensKnowledge,
    });
  });

  it('opens a material and a goal card on the minimal anchors', () => {
    expect(
      hrefOf(
        resolve(
          { kind: 'material', workspaceId: WS, threadId: THREAD, materialId: 'mat_1' },
          threads(true)
        )
      )
    ).toBe(`/materials/${WS}/${THREAD}/mat_1`);
    const card = resolve(
      { kind: 'goal-card', workspaceId: WS, threadId: THREAD, cardId: 'card_1' },
      threads(true, 'goal')
    );
    expect(card).toMatchObject({
      path: `/goals/${WS}/${THREAD}`,
      search: 'card=card_1',
      focus: 'goal-card-card_1',
    });
  });
});
