import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import type { PolicyDecision } from '@openkit/policy-kernel';
import type { PolicyDocumentV1 } from '@openkit/protocol';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { evaluateProductAuthorization } from '../auth/operation-authorizer.js';
import type { CoreDb } from '../storage/db.js';

/** Evaluates the fixture User's current membership action without supplying administrator authority. */
export function workspaceMembershipDecisionFixture(
  coreDb: CoreDb,
  userId: string,
  workspaceId: string
): PolicyDecision {
  return evaluateProductAuthorization(
    coreDb,
    { kind: 'session', userId },
    { kind: 'workspace', workspaceId },
    'membership.manage',
    true
  );
}

/** Produces a current-format managed Thread fixture without supplying runtime authority. */
export function managedThreadPolicy(input: {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly operations?: readonly string[];
  readonly agentId?: string;
}): PolicyDocumentV1 {
  const owner = { kind: 'workspace' as const, workspaceId: input.workspaceId };
  const envelope = {
    author: { kind: 'human' as const, id: input.userId },
    authority: { kind: 'human' as const, userId: input.userId },
    authoredAt: '2026-10-19T00:00:00.000Z',
    state: 'active' as const,
    lifetime: { anchor: { owner, kind: 'workspace', id: input.workspaceId } },
  };
  const resources = [
    { kind: 'container' as const, container: { owner, kind: 'thread', id: input.threadId } },
  ];
  const statements: PolicyDocumentV1['statements'] = [
    {
      ...envelope,
      id: `boundary-${input.threadId}`,
      kind: 'managed-boundary',
      scope: { subjects: [], actions: [], resources },
    },
  ];
  if (input.operations?.length)
    statements.push({
      ...envelope,
      id: `permission-${input.threadId}`,
      kind: 'permission',
      scope: {
        subjects: [{ kind: 'human', id: input.userId }],
        actions: [...input.operations],
        resources,
      },
      effect: 'allow',
      grant: input.agentId
        ? { kind: 'agent-process', agentId: input.agentId }
        : { kind: 'ordinary' },
    });
  return { schemaVersion: 1, statements };
}

/**
 * Authors an explicit managed Thread Policy fixture while preserving other configuration inputs.
 * Returns the original bytes for tests that must restore this fixture before a separate refusal.
 * This supplies no runtime admission, confirmation or author authority.
 */
export function writeManagedThreadPolicyFixture(
  input: Parameters<typeof managedThreadPolicy>[0] & { readonly dataRoot: string }
): string {
  const path = join(input.dataRoot, 'workspaces', input.workspaceId, 'config', 'workspace.jsonc');
  const original = readFileSync(path, 'utf8');
  const authored = parse(original);
  const config = WorkspaceConfigSchema.parse(authored);
  const features = [
    ...new Set([...(config.requiredFeatures ?? []), 'openkit.workspace-resource-policy.v1']),
  ];
  const withFeature = applyEdits(original, modify(original, ['requiredFeatures'], features, {}));
  const mediation = authored.workspace.policy?.mediation ?? { schemaVersion: 1, statements: [] };
  writeFileSync(
    path,
    applyEdits(
      withFeature,
      modify(
        withFeature,
        ['workspace', 'policy', 'mediation'],
        {
          ...mediation,
          statements: [...mediation.statements, ...managedThreadPolicy(input).statements],
        },
        {}
      )
    )
  );
  return original;
}
