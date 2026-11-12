import { describe, expect, it } from 'vitest';
import { anchorFromSearch } from '../chat/timeline/window';
import { type AttentionRow, openHrefForRow } from './data';

function row(value: unknown): AttentionRow {
  return value as AttentionRow;
}

describe('attention row links', () => {
  it('opens a thread row on the attention anchor', () => {
    const href = openHrefForRow(
      row({
        id: 'question:q1',
        workspaceId: 'ws_1',
        threadId: 'th_1',
        turnId: 'tu_1',
        source: {
          type: 'protocol_item',
          itemType: 'user-input-request',
          workspaceId: 'ws_1',
          threadId: 'th_1',
          turnId: 'tu_1',
        },
      })
    );
    expect(href?.startsWith('/chat/ws_1/th_1?')).toBe(true);
    expect(anchorFromSearch(href?.slice(href.indexOf('?')) ?? '')).toEqual({
      kind: 'attention',
      rowId: 'question:q1',
    });
  });

  it('opens a row that names an item on that item', () => {
    const href = openHrefForRow(
      row({
        id: 'question:q1',
        workspaceId: 'ws_1',
        threadId: 'th_1',
        turnId: 'tu_1',
        itemId: 'it_1',
        source: {
          type: 'protocol_item',
          itemType: 'user-input-request',
          workspaceId: 'ws_1',
          threadId: 'th_1',
          turnId: 'tu_1',
          itemId: 'it_1',
        },
      })
    );
    expect(href).toContain('item=it_1');
    expect(href).toContain('attention=question%3Aq1');
    expect(anchorFromSearch(href?.slice(href.indexOf('?')) ?? '')).toEqual({
      kind: 'item',
      itemId: 'it_1',
    });
  });

  it('keeps a recovery record on its workspace-changes anchor', () => {
    expect(
      openHrefForRow(
        row({
          id: 'workspace_recovery:1',
          workspaceId: 'ws_1',
          source: {
            type: 'workspace_recovery',
            workspaceId: 'ws_1',
            reconciliationRecordId: 'wrr_1',
            triggerReason: 'restart',
            stateAfter: 'requires-human',
            affectedRecordIds: ['rec_1'],
            evidenceBundleIds: ['ev_1'],
            requiredHumanDecision: null,
          },
        })
      )
    ).toBe('/workspace-changes?recovery=wrr_1');
  });

  it('does not link knowledge', () => {
    expect(
      openHrefForRow(
        row({
          id: 'knowledge:1',
          workspaceId: 'ws_1',
          source: { type: 'knowledge', workspaceId: 'ws_1' },
        })
      )
    ).toBeNull();
  });
});
