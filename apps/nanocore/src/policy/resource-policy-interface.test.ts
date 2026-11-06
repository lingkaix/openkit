import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { PendingRequestCommandError } from '../runtime/pending-request-error.js';
import {
  checkResourcePolicyOperationIntent,
  createResourcePolicyOperationImplementations,
} from './resource-policy-operations.js';
import { ResourcePolicyRequestIntentSchema } from './resource-policy-requests.js';

/**
 * Pins the exported resource Policy surface without storage or runtime effects.
 *
 * The intent schema is the closed captured contract shared by raise, requester recheck and apply. The
 * operation exports own the unavailable-service refusal, which must appear before any Workspace
 * database is opened.
 */
const userId = 'usr_00000000-0000-7000-8000-000000000001';
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const threadId = 'th_00000000-0000-7000-8000-000000000001';
const turnId = 'tu_00000000-0000-7000-8000-000000000001';
const agentSessionId = 'as_00000000-0000-7000-8000-000000000001';

/** Trusted public entry context; no operation is admitted or executed in this file. */
const publicContext: AdmittedOperationContext = {
  kind: 'public',
  actor: { kind: 'local', userId },
  actorRef: { kind: 'user', id: userId },
  scope: { kind: 'workspace', workspaceId },
};

/** Whole public-origin intent: a Thread boundary replacement captured with its revision. */
const publicIntent: z.input<typeof ResourcePolicyRequestIntentSchema> = {
  operation: 'workspace.resource-access-change',
  origin: { kind: 'public', actor: { kind: 'local', userId } },
  change: {
    resource: { family: 'thread', id: threadId },
    replacement: {
      schemaVersion: 1,
      statements: [
        {
          id: 'managed-thread-boundary',
          kind: 'managed-boundary',
          author: { kind: 'human', id: userId },
          authority: { kind: 'human', userId },
          authoredAt: '2026-10-19T00:00:00.000Z',
          state: 'active',
          scope: {
            subjects: [],
            actions: [],
            resources: [
              {
                kind: 'container',
                container: {
                  owner: { kind: 'workspace', workspaceId },
                  kind: 'thread',
                  id: threadId,
                },
              },
            ],
          },
          lifetime: {
            anchor: {
              owner: { kind: 'workspace', workspaceId },
              kind: 'thread',
              id: threadId,
            },
          },
        },
      ],
    },
    expectedRevision: 'revision-2026-10-19',
  },
};

/** Whole Worker-origin intent: exact lineage plus the explicit-removal change. */
const workerIntent: z.input<typeof ResourcePolicyRequestIntentSchema> = {
  operation: 'workspace.resource-access-change',
  origin: {
    kind: 'worker',
    lineage: {
      workspaceId,
      threadId,
      turnId,
      agentSessionId,
      packageSnapshotId: 'pkg-snapshot-2026-10-19',
    },
  },
  change: {
    resource: { family: 'thread', id: threadId },
    replacement: null,
    expectedRevision: 'revision-2026-10-19',
  },
};

/** Asserts one public refusal names the exact closed-contract violation. */
function expectRefusal(
  intent: unknown,
  issue: { readonly code: string; readonly path: readonly (string | number)[] }
): void {
  const result = ResourcePolicyRequestIntentSchema.safeParse(intent);
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues.map(({ code, path }) => ({ code, path }))).toEqual([issue]);
}

/** Captures one rejection so its public error facts are asserted once. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value: unknown) => {
      throw new Error(`Expected a refusal, received ${JSON.stringify(value)}.`);
    },
    (error: unknown) => error
  );
}

const lineageRefusals: readonly {
  readonly name: string;
  readonly intent: unknown;
  readonly issue: { readonly code: string; readonly path: readonly (string | number)[] };
}[] = [
  {
    name: 'an origin kind outside the closed public and Worker set',
    intent: {
      ...publicIntent,
      origin: { kind: 'service', actor: { kind: 'local', userId } },
    },
    issue: { code: 'invalid_union', path: ['origin', 'kind'] },
  },
  {
    name: 'an extra Worker lineage field',
    intent: {
      ...workerIntent,
      origin: {
        kind: 'worker',
        lineage: {
          workspaceId,
          threadId,
          turnId,
          agentSessionId,
          packageSnapshotId: 'pkg-snapshot-2026-10-19',
          responsibleUserId: userId,
        },
      },
    },
    issue: { code: 'unrecognized_keys', path: ['origin', 'lineage'] },
  },
  {
    name: 'a Worker lineage missing its AgentSession',
    intent: {
      ...workerIntent,
      origin: {
        kind: 'worker',
        lineage: { workspaceId, threadId, turnId, packageSnapshotId: 'pkg-snapshot-2026-10-19' },
      },
    },
    issue: { code: 'invalid_type', path: ['origin', 'lineage', 'agentSessionId'] },
  },
  {
    name: 'a malformed Worker AgentSession identity',
    intent: {
      ...workerIntent,
      origin: {
        kind: 'worker',
        lineage: {
          workspaceId,
          threadId,
          turnId,
          agentSessionId: 'as-not-a-canonical-identity',
          packageSnapshotId: 'pkg-snapshot-2026-10-19',
        },
      },
    },
    issue: { code: 'invalid_format', path: ['origin', 'lineage', 'agentSessionId'] },
  },
  {
    name: 'an extra public actor field',
    intent: {
      ...publicIntent,
      origin: { kind: 'public', actor: { kind: 'local', userId, administrator: true } },
    },
    issue: { code: 'unrecognized_keys', path: ['origin', 'actor'] },
  },
];

const discriminantRefusals: readonly {
  readonly name: string;
  readonly intent: unknown;
  readonly issue: { readonly code: string; readonly path: readonly (string | number)[] };
}[] = [
  {
    name: 'an intent operation outside this governed command',
    intent: { ...publicIntent, operation: 'workspace.resource-access-apply' },
    issue: { code: 'invalid_value', path: ['operation'] },
  },
  {
    name: 'a change resource family outside Thread access',
    intent: {
      ...publicIntent,
      change: { ...publicIntent.change, resource: { family: 'workspace', id: threadId } },
    },
    issue: { code: 'invalid_value', path: ['change', 'resource', 'family'] },
  },
  {
    name: 'a change without the captured configuration revision',
    intent: {
      ...publicIntent,
      change: {
        resource: { family: 'thread', id: threadId },
        replacement: null,
      },
    },
    issue: { code: 'invalid_type', path: ['change', 'expectedRevision'] },
  },
  {
    name: 'an extra intent-level field',
    intent: { ...publicIntent, approvalId: 'request-2026-10-19' },
    issue: { code: 'unrecognized_keys', path: [] },
  },
];

describe('resource Policy request intent schema', () => {
  it('accepts a whole public-origin intent with its exact parsed values', () => {
    expect(ResourcePolicyRequestIntentSchema.parse(publicIntent)).toEqual({
      operation: 'workspace.resource-access-change',
      origin: { kind: 'public', actor: { kind: 'local', userId } },
      change: {
        resource: { family: 'thread', id: threadId },
        replacement: {
          schemaVersion: 1,
          statements: [
            {
              id: 'managed-thread-boundary',
              author: { kind: 'human', id: userId },
              authority: { kind: 'human', userId },
              authoredAt: '2026-10-19T00:00:00.000Z',
              scope: {
                subjects: [],
                actions: [],
                resources: [
                  {
                    kind: 'container',
                    container: {
                      owner: { kind: 'workspace', workspaceId },
                      kind: 'thread',
                      id: threadId,
                    },
                  },
                ],
              },
              lifetime: {
                anchor: {
                  owner: { kind: 'workspace', workspaceId },
                  kind: 'thread',
                  id: threadId,
                },
              },
              kind: 'managed-boundary',
              state: 'active',
            },
          ],
        },
        expectedRevision: 'revision-2026-10-19',
      },
    });
  });

  it('accepts a whole Worker-origin intent with its exact parsed values', () => {
    expect(ResourcePolicyRequestIntentSchema.parse(workerIntent)).toEqual({
      operation: 'workspace.resource-access-change',
      origin: {
        kind: 'worker',
        lineage: {
          workspaceId,
          threadId,
          turnId,
          agentSessionId,
          packageSnapshotId: 'pkg-snapshot-2026-10-19',
        },
      },
      change: {
        resource: { family: 'thread', id: threadId },
        replacement: null,
        expectedRevision: 'revision-2026-10-19',
      },
    });
  });

  it.each(lineageRefusals)('refuses $name', ({ intent, issue }) => {
    expectRefusal(intent, issue);
  });

  it.each(discriminantRefusals)('refuses $name', ({ intent, issue }) => {
    expectRefusal(intent, issue);
  });
});

describe('resource Policy operation implementations', () => {
  it('refuses an access request when the Workspace service is unavailable', async () => {
    // The Workspace database factory is absent, so this deployment cannot reach the command owner.
    const handlers = createResourcePolicyOperationImplementations({ coreDb: undefined });
    const error = await refusal(
      handlers['workspace.resource-access-request'](
        {
          workspaceId,
          threadId,
          requestId: '9c0e0d1a-4f2b-4c3d-8e5f-6a7b8c9d0e1f',
          change: { resource: { family: 'thread', id: threadId }, replacement: null },
        },
        publicContext
      )
    );
    expect(error).toBeInstanceOf(OperationError);
    expect(error).toMatchObject({
      code: 'resource_policy_unavailable',
      message: 'Workspace resource Policy is unavailable.',
      status: 503,
    });
  });

  it('refuses a confirmed apply when the Workspace service is unavailable', async () => {
    const handlers = createResourcePolicyOperationImplementations({ coreDb: undefined });
    const error = await refusal(
      handlers['workspace.resource-access-apply'](
        {
          workspaceId,
          threadId,
          approvalRequestId: 'request-2026-10-19',
          confirmation: 'APPLY WORKSPACE RESOURCE POLICY',
        },
        publicContext
      )
    );
    expect(error).toBeInstanceOf(OperationError);
    expect(error).toMatchObject({
      code: 'resource_policy_unavailable',
      message: 'Workspace resource Policy is unavailable.',
      status: 503,
    });
  });

  it('refuses a governed request at human review when the Workspace service is unavailable', () => {
    // The guard must refuse before it touches storage, so this check supplies no database handle.
    const noWorkspaceDatabase = null as unknown as Parameters<
      typeof checkResourcePolicyOperationIntent
    >[1];
    // Only the three record fields that identify this governed intent are readable before the guard.
    const governedRecord = {
      kind: 'approval',
      serverId: null,
      governedIntent: { operation: 'workspace.resource-access-change' },
    } as unknown as Parameters<typeof checkResourcePolicyOperationIntent>[2];
    let error: unknown;
    try {
      checkResourcePolicyOperationIntent(
        { coreDb: undefined },
        noWorkspaceDatabase,
        governedRecord,
        { kind: 'local', userId }
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PendingRequestCommandError);
    expect(error).toMatchObject({
      code: 'resource_policy_unavailable',
      message: 'Workspace resource Policy is unavailable.',
      status: 503,
    });
  });

  it('leaves a request outside this governed intent to its existing owner', () => {
    const noWorkspaceDatabase = null as unknown as Parameters<
      typeof checkResourcePolicyOperationIntent
    >[1];
    const otherRecord = {
      kind: 'approval',
      serverId: 'server-configured-elsewhere',
      governedIntent: { operation: 'workspace.resource-access-change' },
    } as unknown as Parameters<typeof checkResourcePolicyOperationIntent>[2];
    expect(() =>
      checkResourcePolicyOperationIntent({ coreDb: undefined }, noWorkspaceDatabase, otherRecord, {
        kind: 'local',
        userId,
      })
    ).not.toThrow();
  });
});
