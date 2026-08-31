import type { CoreClient, MetaResponse, WorkspaceRecord } from '@openkit/core-client';
import { createRequestId } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCoreClient } from '../../app/core-client';
import { useCurrentWorkspaceId, useWorkspaces } from '../chat/data';
import { projectSafeValue } from './secret-safe';

/**
 * Settings data hooks (WP-7). Live Settings screens read through `@openkit/core-client` under
 * TanStack Query. Sensitive-adjacent payloads are projected through `projectSafeValue` before
 * they leave these hooks.
 */
export const settingsKeys = {
  workspace: (workspaceId: string) => ['settings', 'workspace', workspaceId] as const,
  workspaceResources: (workspaceId: string) =>
    ['settings', 'workspace-resources', workspaceId] as const,
  vault: (workspaceId: string) => ['settings', 'vault', workspaceId] as const,
  vaultInjectionPlans: (workspaceId: string) =>
    ['settings', 'vault-injection-plans', workspaceId] as const,
  vaultInjectionReceipts: (workspaceId: string) =>
    ['settings', 'vault-injection-receipts', workspaceId] as const,
  evidenceBundles: (workspaceId: string) => ['settings', 'evidence-bundles', workspaceId] as const,
  runtimeEvidence: (workspaceId: string) => ['settings', 'runtime-evidence', workspaceId] as const,
  aepSnapshots: (workspaceId: string) => ['settings', 'aep-snapshots', workspaceId] as const,
  aepSnapshot: (workspaceId: string, snapshotId: string) =>
    ['settings', 'aep-snapshot', workspaceId, snapshotId] as const,
  usage: (workspaceId: string) => ['settings', 'usage', workspaceId] as const,
  meta: ['core', 'meta'] as const,
  aiInterface: ['settings', 'ai-interface'] as const,
};

/** Re-export workspace selection for General settings. */
export { useCurrentWorkspaceId, useWorkspaces };

/** Fixed provider-subscription inventory from `providerSubscriptions.listProviders`. */
export type ProviderSubscriptionsPayload = Awaited<
  ReturnType<CoreClient['providerSubscriptions']['listProviders']>
>;
/** One descriptor from the fixed provider-subscription inventory. */
export type ProviderSubscriptionDescriptor = ProviderSubscriptionsPayload['providers'][number];
/** Provider-scoped account list from `providerSubscriptions.listAccounts`. */
export type ProviderSubscriptionAccountsPayload = Awaited<
  ReturnType<CoreClient['providerSubscriptions']['listAccounts']>
>;
/** Bounded account quota from `providerSubscriptions.getAccountQuota`. */
export type ProviderSubscriptionQuotaPayload = Awaited<
  ReturnType<CoreClient['providerSubscriptions']['getAccountQuota']>
>;
/** Safe connected-app row for the AI interface surface. */
export interface ConnectedAppRow {
  identity: string;
  accountSlotId: string;
  displayName: string;
  status: ProviderSubscriptionAccountsPayload['accounts'][number]['status'];
  accountLabel: string | null;
  planLabel: string | null;
  boundProviderCount: number;
  quotaAvailability: ProviderSubscriptionQuotaPayload['availability'];
  quotaRemainingPercents: number[];
  verificationUrl: string | null;
  userCode: string | null;
  interactionId: string | null;
  message: string | null;
  updatedAt: string;
}

/** Safe provider section for the AI interface surface. */
export interface ConnectedAppProviderRow {
  subscriptionProviderId: ProviderSubscriptionDescriptor['subscriptionProviderId'];
  displayName: string;
  accounts: ConnectedAppRow[];
}

/** Safe control-channel status derived from meta + connection. */
export interface ControlChannelStatus {
  protocolVersion: string;
  capabilityCount: number;
  capabilities: string[];
  reachable: boolean;
}

/** Secret-safe Vault reference metadata exposed to the Settings screen. */
export interface VaultReferenceRow {
  referenceId: string;
  secretKind: string;
  currentVersion: number;
  status: string;
}

/** Secret-safe Vault grant metadata exposed to the Settings screen. */
export interface VaultGrantRow {
  grantId: string;
  vaultReferenceId: string;
  subjectSummary: string | null;
  allowedInjectionPaths: string[];
  lifetime: string;
  status: string;
}

/** Secret-safe Vault-use evidence exposed to the Settings screen. */
export interface VaultUseRow {
  useId: string;
  vaultReferenceId: string;
  resolvingPath: string;
  outcome: string;
  usedAt: string;
}

/** Bounded live Vault projection for board 15. */
export interface VaultProjection {
  references: VaultReferenceRow[];
  grants: VaultGrantRow[];
  uses: VaultUseRow[];
}

/** Secret-safe Vault injection-plan metadata exposed to the Settings screen. */
export interface VaultInjectionPlanRow {
  planId: string;
  injectionVisibility: string;
  expirationBehavior: string;
  status: string;
}

/** Secret-safe Vault injection-receipt metadata exposed to the Settings screen. */
export interface VaultInjectionReceiptRow {
  receiptId: string;
  backendSummary: string;
  revocationStatus: string;
}

/** Product-safe evidence-bundle summary exposed to Debug. */
export interface EvidenceBundleRow {
  id: string;
  summary: string;
}

/** Product-safe runtime-evidence summary exposed to Debug. */
export interface RuntimeEvidenceRow {
  id: string;
  summary: string;
}

/** Product-safe Agent Environment Package snapshot list identity. */
export interface AepSnapshotListRow {
  snapshotId: string;
}

/** Product-safe Agent Environment Package snapshot detail. */
export interface AepSnapshotDetailRow {
  snapshotId: string;
  packageId: string;
  runtimeKind: string;
}

/** Whitelisted capability-call metadata exposed to Usage & audit. */
export interface CapabilityUsageCallRow {
  id: string;
  family: string;
  operation: string;
  status: string;
  summary: string | null;
}

/** Whitelisted metering metadata exposed to Usage & audit. */
export interface UsageRecordRow {
  id: string;
  category: string;
  unit: string;
  quantity: number;
}

/** Whitelisted Workspace audit metadata exposed to Usage & audit. */
export interface WorkspaceAuditEventRow {
  id: string;
  category: string;
  action: string;
  outcome: string;
  summary: string;
}

/** Whitelisted Workspace permission-decision metadata exposed to Usage & audit. */
export interface WorkspacePermissionDecisionRow {
  decisionId: string;
  action: string;
  result: string;
}

/** Bounded selected-Workspace projection for board 17. */
export interface UsageAndAuditProjection {
  capabilityCalls: CapabilityUsageCallRow[];
  usageRecords: UsageRecordRow[];
  auditEvents: WorkspaceAuditEventRow[];
  permissionDecisions: WorkspacePermissionDecisionRow[];
}

/**
 * Projects the three Workspace Vault reads through the shared redaction seam and an
 * explicit display whitelist.
 *
 * @param references Workspace Vault reference response.
 * @param grants Workspace Vault grant response.
 * @param uses Workspace Vault-use response.
 * @returns Secret-safe metadata needed by the Vault screen and nothing else.
 */
export function projectVault(
  references: Awaited<ReturnType<CoreClient['app']['listWorkspaceVaultReferences']>>,
  grants: Awaited<ReturnType<CoreClient['app']['listWorkspaceVaultGrants']>>,
  uses: Awaited<ReturnType<CoreClient['app']['listWorkspaceVaultUseRecords']>>
): VaultProjection {
  return {
    references: references.items.map((reference) => ({
      referenceId: projectSafeValue(reference.referenceId) as string,
      secretKind: projectSafeValue(reference.secretKind) as string,
      currentVersion: reference.currentVersion,
      status: projectSafeValue(reference.status) as string,
    })),
    grants: grants.items.map((grant) => ({
      grantId: projectSafeValue(grant.grantId) as string,
      vaultReferenceId: projectSafeValue(grant.vaultReferenceId) as string,
      subjectSummary:
        grant.subjectSummary === null ? null : (projectSafeValue(grant.subjectSummary) as string),
      allowedInjectionPaths: projectSafeValue(grant.allowedInjectionPaths) as string[],
      lifetime: projectSafeValue(grant.lifetime) as string,
      status: projectSafeValue(grant.status) as string,
    })),
    uses: uses.vaultUseRecords.map((use) => ({
      useId: projectSafeValue(use.useId) as string,
      vaultReferenceId: projectSafeValue(use.vaultReferenceId) as string,
      resolvingPath: projectSafeValue(use.resolvingPath) as string,
      outcome: projectSafeValue(use.outcome) as string,
      usedAt: projectSafeValue(use.usedAt) as string,
    })),
  };
}

/**
 * Projects Workspace Vault injection plans through redaction and an explicit display whitelist.
 *
 * @param plans Workspace injection-plan response.
 * @returns Secret-safe plan rows needed by the Vault screen and nothing else.
 */
export function projectVaultInjectionPlans(
  plans: Awaited<ReturnType<CoreClient['app']['listWorkspaceVaultInjectionPlans']>>
): VaultInjectionPlanRow[] {
  return plans.items.map((plan) => ({
    planId: projectSafeValue(plan.planId) as string,
    injectionVisibility: projectSafeValue(plan.injectionVisibility) as string,
    expirationBehavior: projectSafeValue(plan.expirationBehavior) as string,
    status: projectSafeValue(plan.status) as string,
  }));
}

/**
 * Projects Workspace Vault injection receipts through redaction and an explicit display whitelist.
 *
 * @param receipts Workspace injection-receipt response.
 * @returns Secret-safe receipt rows needed by the Vault screen and nothing else.
 */
export function projectVaultInjectionReceipts(
  receipts: Awaited<ReturnType<CoreClient['app']['listWorkspaceVaultInjectionReceipts']>>
): VaultInjectionReceiptRow[] {
  return receipts.items.map((receipt) => ({
    receiptId: projectSafeValue(receipt.receiptId) as string,
    backendSummary: projectSafeValue(receipt.backendSummary) as string,
    revocationStatus: projectSafeValue(receipt.revocationStatus) as string,
  }));
}

/**
 * Projects Workspace evidence bundles to product-safe summaries.
 *
 * @param bundles Workspace evidence-bundle response.
 * @returns Summary rows with no locators, session ids, or secret-named fields.
 */
export function projectEvidenceBundles(
  bundles: Awaited<ReturnType<CoreClient['app']['listWorkspaceEvidenceBundles']>>
): EvidenceBundleRow[] {
  return bundles.evidenceBundles.map((bundle) => ({
    id: projectSafeValue(bundle.id) as string,
    summary: projectSafeValue(bundle.summary) as string,
  }));
}

/**
 * Projects Workspace runtime evidence to product-safe summaries.
 *
 * @param evidence Workspace runtime-evidence response.
 * @returns Summary rows with no stdout, locators, or session ids.
 */
export function projectRuntimeEvidence(
  evidence: Awaited<ReturnType<CoreClient['app']['listWorkspaceRuntimeEvidence']>>
): RuntimeEvidenceRow[] {
  return evidence.runtimeEvidence.map((record) => ({
    id: projectSafeValue(record.id) as string,
    summary: projectSafeValue(record.summary) as string,
  }));
}

/**
 * Projects Agent Environment Package snapshot list identities.
 *
 * @param snapshots Workspace AEP snapshot list response.
 * @returns Snapshot ids only; detail bodies stay unloaded.
 */
export function projectAepSnapshots(
  snapshots: Awaited<ReturnType<CoreClient['app']['listAgentEnvironmentPackageSnapshots']>>
): AepSnapshotListRow[] {
  return snapshots.items.map((item) => ({
    snapshotId: projectSafeValue(item.snapshotId) as string,
  }));
}

/**
 * Projects one Agent Environment Package snapshot detail from an explicit secret-safe
 * whitelist of schema fields. The nested snapshot blob is never copied into the projection.
 *
 * @param record Exact AEP snapshot read response.
 * @returns Snapshot id, package id, and runtime kind only.
 */
export function projectAepSnapshotDetail(
  record: Awaited<ReturnType<CoreClient['app']['getAgentEnvironmentPackageSnapshot']>>
): AepSnapshotDetailRow {
  return {
    snapshotId: projectSafeValue(record.snapshotId) as string,
    packageId: projectSafeValue(record.packageId) as string,
    runtimeKind: projectSafeValue(record.runtimeKind) as string,
  };
}

/**
 * Projects the three Workspace usage and audit reads through redaction and an explicit display
 * whitelist.
 *
 * @param usage Workspace capability-call and usage response.
 * @param audit Workspace audit-event response.
 * @param decisions Workspace permission-decision response.
 * @returns Safe selected-Workspace evidence needed by the screen and nothing else.
 */
export function projectUsageAndAudit(
  usage: Awaited<ReturnType<CoreClient['app']['getCapabilityUsage']>>,
  audit: Awaited<ReturnType<CoreClient['app']['listWorkspaceAuditEvents']>>,
  decisions: Awaited<ReturnType<CoreClient['app']['listWorkspacePermissionDecisions']>>
): UsageAndAuditProjection {
  return {
    capabilityCalls: usage.capabilityCalls.map((call) => ({
      id: projectSafeValue(call.id) as string,
      family: projectSafeValue(call.family) as string,
      operation: projectSafeValue(call.operation) as string,
      status: projectSafeValue(call.status) as string,
      summary: call.summary === null ? null : (projectSafeValue(call.summary) as string),
    })),
    usageRecords: usage.usageRecords.map((record) => ({
      id: projectSafeValue(record.id) as string,
      category: projectSafeValue(record.category) as string,
      unit: projectSafeValue(record.unit) as string,
      quantity: record.quantity,
    })),
    auditEvents: audit.auditEvents.map((event) => ({
      id: projectSafeValue(event.id) as string,
      category: projectSafeValue(event.category) as string,
      action: projectSafeValue(event.action) as string,
      outcome: projectSafeValue(event.outcome) as string,
      summary: projectSafeValue(event.summary) as string,
    })),
    permissionDecisions: decisions.permissionDecisions.map((decision) => ({
      decisionId: projectSafeValue(decision.decisionId) as string,
      action: projectSafeValue(decision.action) as string,
      result: projectSafeValue(decision.result) as string,
    })),
  };
}

/**
 * Projects a workspace record into a secret-safe display shape.
 *
 * @param workspace Workspace from `core.getWorkspace`.
 * @returns Workspace with no secret-shaped fields.
 */
export function projectWorkspace(workspace: WorkspaceRecord): WorkspaceRecord {
  return projectSafeValue(workspace) as WorkspaceRecord;
}

/**
 * Projects one provider-scoped account list and its quotas into safe status rows.
 *
 * @param provider Fixed provider inventory descriptor.
 * @param payload Provider-scoped account list.
 * @param quotas Quota result for each account at the matching array index.
 * @returns Provider section with account rows, including pending device-code fields.
 */
export function projectConnectedApps(
  provider: ProviderSubscriptionDescriptor,
  payload: ProviderSubscriptionAccountsPayload,
  quotas: readonly ProviderSubscriptionQuotaPayload[]
): ConnectedAppProviderRow {
  const safeProvider = projectSafeValue(provider) as ProviderSubscriptionDescriptor;
  const safePayload = projectSafeValue(payload) as ProviderSubscriptionAccountsPayload;
  const safeQuotas = projectSafeValue(quotas) as ProviderSubscriptionQuotaPayload[];
  return {
    subscriptionProviderId: safeProvider.subscriptionProviderId,
    displayName: safeProvider.displayName,
    accounts: safePayload.accounts.map((account, index) => {
      if (account.subscriptionProviderId !== safeProvider.subscriptionProviderId) {
        throw new Error('Provider subscription projection failed.');
      }
      const quota = safeQuotas[index];
      if (
        !quota ||
        quota.subscriptionProviderId !== account.subscriptionProviderId ||
        quota.accountSlotId !== account.accountSlotId
      ) {
        throw new Error('Provider subscription projection failed.');
      }
      const raw = payload.accounts[index];
      const interaction = raw?.status === 'pending' ? raw.interaction : undefined;
      const message =
        account.status === 'unavailable' || account.status === 'error'
          ? account.message
          : undefined;
      return {
        identity: `${account.subscriptionProviderId}:${account.accountSlotId}`,
        accountSlotId: account.accountSlotId,
        displayName: account.displayName ?? `Account ${account.accountSlotId}`,
        status: account.status,
        accountLabel: account.accountLabel ?? null,
        planLabel: account.planLabel ?? null,
        boundProviderCount: account.boundProviderIds.length,
        quotaAvailability: quota.availability,
        quotaRemainingPercents:
          quota.availability === 'available'
            ? quota.windows.flatMap((window) =>
                window.remainingPercent === undefined ? [] : [window.remainingPercent]
              )
            : [],
        verificationUrl: interaction?.verificationUrl
          ? (projectSafeValue(interaction.verificationUrl) as string)
          : null,
        userCode: interaction?.userCode ? (projectSafeValue(interaction.userCode) as string) : null,
        interactionId: interaction?.interactionId ?? null,
        message: message === undefined ? null : (projectSafeValue(message) as string),
        updatedAt: account.updatedAt,
      };
    }),
  };
}

/**
 * Projects meta into control-channel status (no secrets).
 *
 * @param meta `core.meta` response.
 * @param reachable Whether the connection probe succeeded.
 * @returns Control-channel status for board 20.
 */
export function projectControlChannel(
  meta: MetaResponse | undefined,
  reachable: boolean
): ControlChannelStatus | null {
  if (!meta) return null;
  const safe = projectSafeValue(meta) as MetaResponse;
  return {
    protocolVersion: safe.protocolVersion,
    capabilityCount: safe.capabilities.length,
    capabilities: [...safe.capabilities],
    reachable,
  };
}

/** Load the active workspace for General settings. */
export function useSettingsWorkspace(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: settingsKeys.workspace(workspaceId ?? ''),
    queryFn: async () => projectWorkspace(await client.core.getWorkspace(workspaceId as string)),
    enabled: Boolean(workspaceId),
  });
}

/** Load the selectable models, agents, and skills for General settings. */
export function useSettingsWorkspaceResources(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: settingsKeys.workspaceResources(workspaceId ?? ''),
    queryFn: () => client.core.getWorkspaceResources(workspaceId as string),
    enabled: Boolean(workspaceId),
  });
}

/** Load meta for control-channel / capability status. */
export function useMetaStatus() {
  const client = useCoreClient();
  return useQuery({
    queryKey: settingsKeys.meta,
    queryFn: async () => projectSafeValue(await client.core.meta()) as MetaResponse,
  });
}

/**
 * Loads the bounded live Vault metadata projection for the active Workspace.
 *
 * @param workspaceId Active Workspace identity, or null before selection resolves.
 * @returns TanStack query for the three-read Workspace Vault projection.
 */
export function useVault(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: settingsKeys.vault(workspaceId ?? ''),
    queryFn: async () => {
      const [references, grants, uses] = await Promise.all([
        client.app.listWorkspaceVaultReferences(workspaceId as string),
        client.app.listWorkspaceVaultGrants(workspaceId as string),
        client.app.listWorkspaceVaultUseRecords(workspaceId as string),
      ]);
      return projectVault(references, grants, uses);
    },
    enabled: Boolean(workspaceId),
  });
}

/**
 * Loads selected-Workspace Vault injection plans independently of other Vault families.
 *
 * @param workspaceId Active Workspace identity, or null before selection resolves.
 * @returns TanStack query for the injection-plan projection.
 */
export function useVaultInjectionPlans(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: settingsKeys.vaultInjectionPlans(workspaceId ?? ''),
    queryFn: async () =>
      projectVaultInjectionPlans(
        await client.app.listWorkspaceVaultInjectionPlans(workspaceId as string)
      ),
    enabled: Boolean(workspaceId),
  });
}

/**
 * Loads selected-Workspace Vault injection receipts independently of other Vault families.
 *
 * @param workspaceId Active Workspace identity, or null before selection resolves.
 * @returns TanStack query for the injection-receipt projection.
 */
export function useVaultInjectionReceipts(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: settingsKeys.vaultInjectionReceipts(workspaceId ?? ''),
    queryFn: async () =>
      projectVaultInjectionReceipts(
        await client.app.listWorkspaceVaultInjectionReceipts(workspaceId as string)
      ),
    enabled: Boolean(workspaceId),
  });
}

/**
 * Loads selected-Workspace evidence-bundle summaries for Debug.
 *
 * @param workspaceId Validated selected Workspace identity, or null before discovery resolves.
 * @returns TanStack query for product-safe evidence summaries.
 */
export function useEvidenceBundles(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: settingsKeys.evidenceBundles(workspaceId ?? ''),
    queryFn: async () =>
      projectEvidenceBundles(await client.app.listWorkspaceEvidenceBundles(workspaceId as string)),
    enabled: Boolean(workspaceId),
  });
}

/**
 * Loads selected-Workspace runtime-evidence summaries for Debug.
 *
 * @param workspaceId Validated selected Workspace identity, or null before discovery resolves.
 * @returns TanStack query for product-safe runtime summaries.
 */
export function useRuntimeEvidence(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: settingsKeys.runtimeEvidence(workspaceId ?? ''),
    queryFn: async () =>
      projectRuntimeEvidence(await client.app.listWorkspaceRuntimeEvidence(workspaceId as string)),
    enabled: Boolean(workspaceId),
  });
}

/**
 * Loads selected-Workspace Agent Environment Package snapshot identities for Debug.
 *
 * @param workspaceId Validated selected Workspace identity, or null before discovery resolves.
 * @returns TanStack query for snapshot ids only.
 */
export function useAepSnapshots(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: settingsKeys.aepSnapshots(workspaceId ?? ''),
    queryFn: async () =>
      projectAepSnapshots(
        await client.app.listAgentEnvironmentPackageSnapshots(workspaceId as string)
      ),
    enabled: Boolean(workspaceId),
  });
}

/**
 * Loads one exact Agent Environment Package snapshot after the operator selects it.
 *
 * @param workspaceId Validated selected Workspace identity, or null before discovery resolves.
 * @param snapshotId Selected snapshot identity, or null before selection.
 * @returns TanStack query for the product-safe snapshot summary.
 */
export function useAepSnapshotDetail(workspaceId: string | null, snapshotId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: settingsKeys.aepSnapshot(workspaceId ?? '', snapshotId ?? ''),
    queryFn: async () =>
      projectAepSnapshotDetail(
        await client.app.getAgentEnvironmentPackageSnapshot(
          workspaceId as string,
          snapshotId as string
        )
      ),
    enabled: Boolean(workspaceId && snapshotId),
  });
}

/**
 * Loads the bounded live usage, audit, and permission projection for the selected Workspace.
 *
 * @param workspaceId Validated selected Workspace identity, or null before discovery resolves.
 * @returns TanStack query for the exact three-read Workspace projection.
 */
export function useUsageAndAudit(workspaceId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: settingsKeys.usage(workspaceId ?? ''),
    queryFn: async () => {
      const [usage, audit, decisions] = await Promise.all([
        client.app.getCapabilityUsage(workspaceId as string),
        client.app.listWorkspaceAuditEvents(workspaceId as string),
        client.app.listWorkspacePermissionDecisions(workspaceId as string),
      ]);
      return projectUsageAndAudit(usage, audit, decisions);
    },
    enabled: Boolean(workspaceId),
  });
}

/** Update the active workspace display name from General settings. */
export function useUpdateWorkspaceName(workspaceId: string | null) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string): Promise<WorkspaceRecord> =>
      client.core.updateWorkspace(workspaceId as string, {
        name,
        requestId: createRequestId(),
      }),
    onSuccess: (workspace) => {
      if (workspaceId) {
        void queryClient.invalidateQueries({ queryKey: settingsKeys.workspace(workspaceId) });
      }
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      return projectWorkspace(workspace);
    },
  });
}
