import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  InjectionVisibilitySchema,
  ListWorkspaceVaultGrantsResponseSchema,
  ListWorkspaceVaultInjectionPlansResponseSchema,
  ListWorkspaceVaultInjectionReceiptsResponseSchema,
  WorkspaceVaultGrantSchema,
  WorkspaceVaultInjectionPlanSchema,
  WorkspaceVaultInjectionReceiptSchema,
} from './index.js';

const workspaceId = allocateEntityId('ws');
const grantId = allocateEntityId('grant');
const vaultReferenceId = allocateEntityId('vault');
const agentSessionId = allocateEntityId('as');
const capabilityCallId = allocateEntityId('cap');
const auditEventId = allocateEntityId('aud');
const policyDecisionId = allocateEntityId('pd');
const timestamp = '2026-10-16T00:00:00.000Z';

const validGrant = {
  issuance: 'target' as const,
  grantId,
  vaultReferenceId,
  ownerScope: 'workspace' as const,
  workspaceId,
  userId: null,
  subjectSummary: 'Codex worker runtime environment',
  targetAgentId: 'agent_codex',
  targetAgentSessionId: agentSessionId,
  targetCapabilityId: null,
  allowedInjectionPaths: ['runtime-env'],
  lifetime: 'session' as const,
  policyDecisionId,
  approvalId: 'approval_1',
  status: 'active' as const,
  createdAt: timestamp,
  expiresAt: null,
};

const validPlan = {
  planId: 'plan_1',
  grantId,
  packageSnapshotId: 'snap_1',
  capabilityId: null,
  injectionVisibility: 'runtime-env' as const,
  targetPath: null,
  targetEnvVarName: 'PROVIDER_API_KEY',
  expirationBehavior: 'clear-on-session-end',
  revocationBehavior: 'terminate-session',
  redactionRule: 'mask-prefix',
  backendCapabilityRequirement: 'env-injection',
  status: 'active' as const,
  createdAt: timestamp,
};

const validReceipt = {
  receiptId: 'rcpt_1',
  planId: 'plan_1',
  grantId,
  agentSessionId,
  capabilityCallId,
  backendSummary: 'Injected into worker runtime env',
  injectedAt: timestamp,
  expiresAt: null,
  revocationStatus: 'active' as const,
  auditEventId,
};

describe('workspace vault grant, plan, and receipt schemas', () => {
  it('admits valid WorkspaceVaultGrantSchema metadata and refuses raw secret-shaped strings or non-null userId', () => {
    expect(WorkspaceVaultGrantSchema.parse(validGrant)).toEqual(validGrant);

    for (const invalid of [
      { ...validGrant, ownerScope: 'server' },
      { ...validGrant, userId: allocateEntityId('usr') },
      { ...validGrant, subjectSummary: 'leaked sk-fixture token' },
      { ...validGrant, allowedInjectionPaths: ['hf_fixture'] },
      { ...validGrant, extraField: true },
    ]) {
      expect(WorkspaceVaultGrantSchema.safeParse(invalid).success).toBe(false);
    }

    expect(
      ListWorkspaceVaultGrantsResponseSchema.parse({
        workspaceId,
        items: [validGrant],
      }).items
    ).toHaveLength(1);
  });

  it('enforces closed InjectionVisibilitySchema and refuses raw secret-shaped strings in WorkspaceVaultInjectionPlanSchema', () => {
    expect(InjectionVisibilitySchema.safeParse('external-handle').success).toBe(true);
    expect(InjectionVisibilitySchema.safeParse('host-shell').success).toBe(false);

    expect(WorkspaceVaultInjectionPlanSchema.parse(validPlan)).toEqual(validPlan);

    for (const invalid of [
      { ...validPlan, injectionVisibility: 'unknown-visibility' },
      { ...validPlan, targetEnvVarName: 'ghp_fixture' },
      { ...validPlan, redactionRule: 'okt_fixture' },
    ]) {
      expect(WorkspaceVaultInjectionPlanSchema.safeParse(invalid).success).toBe(false);
    }

    expect(
      ListWorkspaceVaultInjectionPlansResponseSchema.parse({
        workspaceId,
        items: [validPlan],
      }).items
    ).toHaveLength(1);
  });

  it('enforces revocationStatus and rejects raw secret-shaped strings in WorkspaceVaultInjectionReceiptSchema and list responses', () => {
    expect(WorkspaceVaultInjectionReceiptSchema.parse(validReceipt)).toEqual(validReceipt);

    for (const invalid of [
      { ...validReceipt, revocationStatus: 'unknown' },
      { ...validReceipt, backendSummary: 'used sk-fixture key' },
    ]) {
      expect(WorkspaceVaultInjectionReceiptSchema.safeParse(invalid).success).toBe(false);
    }

    expect(
      ListWorkspaceVaultInjectionReceiptsResponseSchema.parse({
        workspaceId,
        items: [validReceipt],
      }).items
    ).toHaveLength(1);
  });
});
