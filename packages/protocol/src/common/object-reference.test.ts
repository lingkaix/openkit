import { describe, expect, it } from 'vitest';
import {
  PageReferenceSchema,
  parseReferenceScope,
  ReferenceScopeIdSchema,
  RetrievalTraceReferenceSchema,
  ScopeQualifiedReferenceSchema,
} from '../index.js';

const traceId = 'krt_0190f4c8-0000-7000-8000-000000000001';

describe('scope-qualified reference contract', () => {
  it.each([
    ['page/server', { family: 'page', kind: 'server' }],
    [
      'page/user/usr_00000000-0000-7ed7-bc55-952204fd7048',
      { family: 'page', kind: 'user', userId: 'usr_00000000-0000-7ed7-bc55-952204fd7048' },
    ],
    [
      'page/workspace/ws_00000000-0000-7075-8a5a-74c8c6e85b6e',
      { family: 'page', kind: 'workspace', workspaceId: 'ws_00000000-0000-7075-8a5a-74c8c6e85b6e' },
    ],
    [
      'retrieval-trace/thread/ws_00000000-0000-7075-8a5a-74c8c6e85b6e/th_00000000-0000-7d53-83f1-7e7cac9ae169',
      {
        family: 'retrieval-trace',
        kind: 'thread',
        workspaceId: 'ws_00000000-0000-7075-8a5a-74c8c6e85b6e',
        threadId: 'th_00000000-0000-7d53-83f1-7e7cac9ae169',
      },
    ],
    ...['tu_00000000-0000-72cd-966c-00128857206d', 'tu_00000000-0000-7100-995b-2b7a9aa25220'].map(
      (turnId) => [
        `retrieval-trace/turn/ws_00000000-0000-7075-8a5a-74c8c6e85b6e/th_00000000-0000-7d53-83f1-7e7cac9ae169/${turnId}`,
        {
          family: 'retrieval-trace',
          kind: 'turn',
          workspaceId: 'ws_00000000-0000-7075-8a5a-74c8c6e85b6e',
          threadId: 'th_00000000-0000-7d53-83f1-7e7cac9ae169',
          turnId,
        },
      ]
    ),
  ] as const)('parses the exact owner and identity of %s', (scopeId, expected) => {
    expect(parseReferenceScope(scopeId)).toEqual(expected);
    expect(ReferenceScopeIdSchema.parse(scopeId)).toBe(scopeId);
  });

  it.each([
    '',
    '/page/server',
    'page/server/',
    'page//server',
    'page/./server',
    'page/../server',
    'page',
    'page/server/extra',
    'page/user',
    'page/user/user_',
    'page/user/ws_00000000-0000-7075-8a5a-74c8c6e85b6e',
    `page/user/${'a'.repeat(31)}`,
    `page/user/${'a'.repeat(32)}`,
    `page/user/${'a'.repeat(33)}`,
    `page/user/${'-'.repeat(32)}`,
    'page/user/usr_00000000-0000-7ed7-bc55-952204fd7048/extra',
    'page/workspace',
    'page/workspace/ws_',
    'page/workspace/th_00000000-0000-7d53-83f1-7e7cac9ae169',
    'page/workspace/ws_00000000-0000-7075-8a5a-74c8c6e85b6e/extra',
    'page/thread/th_00000000-0000-7d53-83f1-7e7cac9ae169',
    'unknown/server',
    'server/current/page/server',
    'retrieval-trace',
    'retrieval-trace/server/ws_00000000-0000-7075-8a5a-74c8c6e85b6e/th_00000000-0000-7d53-83f1-7e7cac9ae169',
    'retrieval-trace/thread',
    'retrieval-trace/thread/ws_00000000-0000-7075-8a5a-74c8c6e85b6e',
    'retrieval-trace/thread/ws_/th_00000000-0000-7d53-83f1-7e7cac9ae169',
    'retrieval-trace/thread/th_00000000-0000-7d53-83f1-7e7cac9ae169/th_00000000-0000-7d53-83f1-7e7cac9ae169',
    'retrieval-trace/thread/ws_00000000-0000-7075-8a5a-74c8c6e85b6e/th_',
    'retrieval-trace/thread/ws_00000000-0000-7075-8a5a-74c8c6e85b6e/ws_00000000-0000-7075-8a5a-74c8c6e85b6e',
    'retrieval-trace/thread/ws_00000000-0000-7075-8a5a-74c8c6e85b6e/th_00000000-0000-7d53-83f1-7e7cac9ae169/extra',
    'retrieval-trace/turn/ws_00000000-0000-7075-8a5a-74c8c6e85b6e/th_00000000-0000-7d53-83f1-7e7cac9ae169',
    'retrieval-trace/turn/ws_00000000-0000-7075-8a5a-74c8c6e85b6e/th_00000000-0000-7d53-83f1-7e7cac9ae169/tu_',
    'retrieval-trace/turn/ws_00000000-0000-7075-8a5a-74c8c6e85b6e/th_00000000-0000-7d53-83f1-7e7cac9ae169/turn_',
    'retrieval-trace/turn/ws_00000000-0000-7075-8a5a-74c8c6e85b6e/th_00000000-0000-7d53-83f1-7e7cac9ae169/th_00000000-0000-7d53-83f1-7e7cac9ae169',
    'retrieval-trace/turn/ws_00000000-0000-7075-8a5a-74c8c6e85b6e/th_00000000-0000-7d53-83f1-7e7cac9ae169/tu_00000000-0000-72cd-966c-00128857206d/extra',
    'retrieval-trace/turn/ws_00000000-0000-7075-8a5a-74c8c6e85b6e/../tu_00000000-0000-72cd-966c-00128857206d',
  ])('rejects a malformed scope or wrong identifier kind: %s', (scopeId) => {
    expect(parseReferenceScope(scopeId)).toBeNull();
    expect(ReferenceScopeIdSchema.safeParse(scopeId).success).toBe(false);
  });

  it('keeps page object paths separate from scope and rejects authority-bearing additions', () => {
    const reference = {
      scopeId: 'page/workspace/ws_00000000-0000-7075-8a5a-74c8c6e85b6e',
      objectId: 'research/topic',
    };
    expect(PageReferenceSchema.parse(reference)).toEqual(reference);
    expect(ScopeQualifiedReferenceSchema.parse(reference)).toEqual(reference);
    expect(PageReferenceSchema.safeParse({ ...reference, objectId: '' }).success).toBe(false);
    expect(
      ScopeQualifiedReferenceSchema.safeParse({ ...reference, serverId: 'another-server' }).success
    ).toBe(false);
    expect(
      PageReferenceSchema.safeParse({
        scopeId:
          'retrieval-trace/thread/ws_00000000-0000-7075-8a5a-74c8c6e85b6e/th_00000000-0000-7d53-83f1-7e7cac9ae169',
        objectId: traceId,
      }).success
    ).toBe(false);
  });

  it('admits only trace scopes with a canonical trace object id', () => {
    const reference = {
      scopeId:
        'retrieval-trace/thread/ws_00000000-0000-7075-8a5a-74c8c6e85b6e/th_00000000-0000-7d53-83f1-7e7cac9ae169',
      objectId: traceId,
    };
    expect(RetrievalTraceReferenceSchema.parse(reference)).toEqual(reference);
    expect(
      RetrievalTraceReferenceSchema.safeParse({ ...reference, scopeId: 'page/server' }).success
    ).toBe(false);
    for (const objectId of [
      '',
      'topic',
      traceId.replace('krt_', ''),
      traceId.replace('-8000-', '-0000-'),
    ])
      expect(RetrievalTraceReferenceSchema.safeParse({ ...reference, objectId }).success).toBe(
        false
      );
  });
});

it('resolves exact file scopes without treating versions or input ordinals as new entity ids', () => {
  for (const [scopeId, expected] of [
    [
      'artifact/workspace/ws_current',
      { family: 'artifact', kind: 'workspace', workspaceId: 'ws_current' },
    ],
    [
      'material/workspace/ws_current',
      { family: 'material', kind: 'workspace', workspaceId: 'ws_current' },
    ],
    [
      'input/turn/ws_current/th_current/tu_current',
      {
        family: 'input',
        kind: 'turn',
        workspaceId: 'ws_current',
        threadId: 'th_current',
        turnId: 'tu_current',
      },
    ],
  ] as const) {
    expect(parseReferenceScope(scopeId)).toEqual(expected);
    expect(
      ScopeQualifiedReferenceSchema.safeParse({
        scopeId,
        objectId: scopeId.startsWith('input/') ? '0' : 'opaque-current-id',
      }).success
    ).toBe(true);
  }
  for (const scopeId of [
    'artifact/server',
    'artifact/workspace/th_current',
    'material/workspace/ws_current/extra',
    'input/thread/ws_current/th_current',
    'input/turn/ws_current/th_current/th_current',
  ]) {
    expect(parseReferenceScope(scopeId)).toBeNull();
  }
  for (const objectId of ['', '-1', '+1', '01', '1.0', '1e2', '0/1', '9007199254740992']) {
    expect(
      ScopeQualifiedReferenceSchema.safeParse({
        scopeId: 'input/turn/ws_current/th_current/tu_current',
        objectId,
      }).success
    ).toBe(false);
  }
  for (const family of ['artifact', 'material']) {
    expect(
      ScopeQualifiedReferenceSchema.safeParse({
        scopeId: `${family}/workspace/ws_current`,
        objectId: 'a/b',
      }).success
    ).toBe(false);
  }
});
