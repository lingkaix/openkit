import {
  allocateEntityId,
  type PolicyDocumentV1,
  PolicyPermissionV1Schema,
} from '@openkit/protocol';
import { recordPolicyWriteDecision } from '../policy/configuration.js';
import type { InterceptionInput } from '../policy/interception.js';
import {
  EMPTY_POLICY_DOCUMENT,
  policyDigest,
  preparePolicyDocument,
} from '../policy/statements.js';
import type { CoreDb } from '../storage/db.js';

/** Explicit synthetic condition for common pipeline tests; this does not admit native authority. */
export function withHumanMcpApproval(
  input: Pick<InterceptionInput, 'document' | 'proposal'>
): PolicyDocumentV1 {
  const { workspaceId, resource, subject } = input.proposal;
  if (resource.kind !== 'mcp-tool') throw new Error('MCP Tool condition requires an MCP resource.');
  const { serverId, toolName } = resource;
  return {
    ...input.document,
    statements: [
      ...input.document.statements,
      PolicyPermissionV1Schema.parse({
        id: 'human-tool-condition',
        kind: 'permission',
        state: 'active',
        effect: 'require_approval',
        grant: { kind: 'ordinary' },
        author: { kind: 'human', id: subject.responsibleHumanId },
        authority: { kind: 'human', userId: subject.responsibleHumanId },
        authoredAt: '2026-10-18T00:00:00Z',
        scope: {
          subjects: [subject.principal],
          actions: ['tool.use'],
          resources: [{ kind: 'mcp-tool', workspaceId, serverId, toolName }],
        },
        lifetime: {
          anchor: { owner: { kind: 'workspace', workspaceId }, kind: 'workspace', id: workspaceId },
        },
      }),
    ],
  };
}

/** Explicitly records fixture human admission; production candidate/confirmation is tested separately. */
export function admitTestMcpApproval(input: {
  coreDb: CoreDb;
  document?: PolicyDocumentV1;
  workspaceId: string;
  serverId: string;
  toolName: string;
  userId: string;
  principal?: InterceptionInput['proposal']['subject']['principal'];
  threadId: string;
  turnId: string;
}): PolicyDocumentV1 {
  const current = input.document ?? EMPTY_POLICY_DOCUMENT;
  const statement = PolicyPermissionV1Schema.parse({
    id: `human-tool-condition-${input.serverId}-${input.toolName}`,
    kind: 'permission',
    state: 'active',
    effect: 'require_approval',
    grant: { kind: 'ordinary' },
    author: { kind: 'human', id: input.userId },
    authority: { kind: 'human', userId: input.userId },
    authoredAt: new Date().toISOString(),
    scope: {
      subjects: [input.principal ?? { kind: 'human', id: input.userId }],
      actions: ['tool.use'],
      resources: [
        {
          kind: 'mcp-tool',
          workspaceId: input.workspaceId,
          serverId: input.serverId,
          toolName: input.toolName,
        },
      ],
    },
    lifetime: {
      anchor: {
        owner: { kind: 'workspace', workspaceId: input.workspaceId },
        kind: 'workspace',
        id: input.workspaceId,
      },
    },
  });
  const prepared = preparePolicyDocument({
    current,
    proposed: { ...current, statements: [...current.statements, statement] },
    userId: input.userId,
    now: new Date().toISOString(),
  });
  recordPolicyWriteDecision({
    coreDb: input.coreDb,
    actor: { kind: 'local', userId: input.userId },
    candidate: {
      artifactId: allocateEntityId('ar'),
      contentDigest: policyDigest(prepared.document),
    },
    proposal: {
      schemaVersion: 1,
      proposer: { kind: 'human', id: input.userId },
      rationale: 'Explicit fixture human Tool condition.',
      baseRevision: policyDigest(current),
      proposed: prepared.document,
      validation: 'valid',
    },
    requestId: 'test-human-tool-condition',
    threadId: input.threadId,
    turnId: input.turnId,
  });
  return prepared.document;
}
