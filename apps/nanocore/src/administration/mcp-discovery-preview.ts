import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationInput, OperationOutput } from '@openkit/app-api-schemas';
import { digestOpenKitTree } from '@openkit/config-schema';
import { recordServerAuditEvent } from '../audit-events.js';
import { requireCurrentDeploymentAdmin } from '../auth/operation-authorizer.js';
import { loadResourceCatalog, mcpTransportFromDeclaration } from '../catalog/resource-catalog.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import { type AdmittedOperationContext, publicOperationActor } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import {
  createDefaultWorkerMcpGateway,
  WorkerMcpGatewayCallError,
  type WorkerMcpGatewayCredentials,
  type WorkerMcpGatewayServerInput,
} from '../runtime/worker-mcp-gateway.js';
import { resolveDataRootPath } from '../storage/fs-layout.js';
import { isTargetIssuedEffectAuthority } from '../storage/workspace-import-authority.js';
import { isCurrentServerMcpMaterial } from '../vault/server-mcp-authority.js';
import { vaultSecretMaterialToString } from '../vault/vault-backend.js';
import { getVaultGrant } from '../vault/vault-grants.js';
import { getVaultReference } from '../vault/vault-references.js';
import { createVaultUseAuditedBackend } from '../vault/vault-use-audited-backend.js';
import { createVaultInjectionPlan } from '../vault-injection-plans.js';
import { createVaultInjectionReceipt } from '../vault-injection-receipts.js';

type Input = OperationInput<'administration.mcp-discovery-preview'>;

/** Observe one canonical configuration through a fresh existing Gateway; no Worker admission is fabricated. */
export async function previewMcpDiscovery(
  dependencies: OperationInvocationDependencies,
  input: Input,
  context: AdmittedOperationContext
) {
  try {
    const coreDb = dependencies.coreDb;
    const dataRoot = dependencies.dataRoot ?? dependencies.store?.getDataRoot();
    if (!coreDb || !dataRoot)
      throw new OperationError('storage_unavailable', 'MCP preview storage is unavailable.', 503);
    const actor = publicOperationActor(context);
    const scope = input.catalogScope;
    const workspaceId = scope.kind === 'workspace' ? scope.workspaceId : null;
    const previewId = randomUUID();
    const currentAdmin = () => {
      try {
        return requireCurrentDeploymentAdmin(coreDb, actor);
      } catch {
        throw new OperationError('forbidden', 'Current administrator authority is required.', 403);
      }
    };
    /** Compare exact retained authority before contacting upstream and after every asynchronous discovery boundary. */
    const current = () => {
      currentAdmin();
      if (workspaceId) {
        const workspace = dependencies.store?.getWorkspace(workspaceId);
        if (!workspace || workspace.status !== 'active')
          throw new OperationError('not_found', 'MCP preview Workspace is unavailable.', 404);
      }
      const catalog = loadResourceCatalog(dataRoot, scope);
      const entry = catalog.mcp.entries.find((candidate) => candidate.id === input.mcpId);
      const version = catalog.mcp.versions.find(
        (candidate) => candidate.entryId === input.mcpId && candidate.digest === input.versionDigest
      );
      const binding = catalog.mcp.bindings.find((candidate) => candidate.entryId === input.mcpId);
      if (
        catalog.revision !== input.expectedRevision ||
        (binding?.revision ?? null) !== input.expectedBindingRevision
      )
        throw new OperationError(
          'conflict',
          'MCP preview identity is stale. Read current configuration.',
          409
        );
      if (!entry || entry.availability === 'removed' || !version)
        throw new OperationError('not_found', 'MCP preview configuration is unavailable.', 404);
      return { catalog, version };
    };
    const source = current();
    const backend = dependencies.vaultUnlockState?.backend();
    const environment: Record<string, string> = {};
    const headers: Record<string, string> = {};
    const query: Record<string, string> = {};
    let bearer: string | undefined;
    const injections: Array<{
      grantId: string;
      referenceId: string;
      version: number;
      planId: string;
      receiptId: string;
      injectedAt: string;
      expiresAt: string | null;
    }> = [];
    const transport = mcpTransportFromDeclaration(source.version.declaration);
    const sinks = new Set<string>();
    const slots = new Set<string>();
    /** Human preview cannot satisfy a Worker target or borrow another scope's grant. */
    const authority = (grantId: string) => {
      const grant = getVaultGrant(coreDb, grantId);
      const reference = grant ? getVaultReference(coreDb, grant.vaultReferenceId) : null;
      const expiry = grant?.expiresAt ? Date.parse(grant.expiresAt) : null;
      if (
        !backend ||
        backend.health().state !== 'available' ||
        !grant ||
        !reference ||
        grant.status !== 'active' ||
        reference.status !== 'active' ||
        !isTargetIssuedEffectAuthority(grant.grantId) ||
        (grant.approvalId !== null &&
          (!isTargetIssuedEffectAuthority(grant.approvalId) || grant.policyDecisionId === null)) ||
        (expiry !== null &&
          (!Number.isFinite(expiry) ||
            expiry <= Date.now() ||
            new Date(expiry).toISOString() !== grant.expiresAt)) ||
        grant.ownerScope !== scope.kind ||
        reference.ownerScope !== scope.kind ||
        grant.workspaceId !== workspaceId ||
        reference.workspaceId !== workspaceId ||
        grant.userId !== null ||
        reference.userId !== null ||
        grant.targetAgentId !== null ||
        grant.targetAgentSessionId !== null ||
        (grant.targetCapabilityId !== null && grant.targetCapabilityId !== 'mcp.list_tools') ||
        grant.allowedInjectionPaths.length !== 1 ||
        grant.allowedInjectionPaths[0] !== 'gateway-only' ||
        reference.backendKind !== backend.kind ||
        (scope.kind === 'server' &&
          (grant.lifetime !== 'server' || !isCurrentServerMcpMaterial(backend, reference)))
      )
        throw new OperationError(
          'forbidden',
          'MCP preview credential authority is unavailable.',
          403
        );
      const inventory = backend
        .listReferences({ ownerScope: scope.kind, ...(workspaceId ? { workspaceId } : {}) })
        .find((candidate) => candidate.referenceId === reference.referenceId);
      if (
        !inventory ||
        inventory.revoked ||
        inventory.currentVersion !== reference.currentVersion ||
        inventory.ownerScope !== scope.kind ||
        (inventory.workspaceId ?? null) !== workspaceId ||
        inventory.userId !== undefined ||
        inventory.providerSubscriptionAccount !== undefined
      )
        throw new OperationError(
          'forbidden',
          'MCP preview credential authority is unavailable.',
          403
        );
      return { grant, reference };
    };
    // Validate every sink and grant before resolving any material or making a connection.
    for (const binding of input.credentialBindings) {
      const sinkKey = `${binding.sink.kind}:${binding.sink.kind === 'header' ? binding.sink.name.toLowerCase() : binding.sink.name}`;
      if (
        slots.has(binding.slot) ||
        sinks.has(sinkKey) ||
        (transport.kind === 'stdio' ? binding.sink.kind !== 'env' : binding.sink.kind === 'env') ||
        ['PLUGIN_DATA', 'PLUGIN_ROOT'].includes(binding.sink.name) ||
        (transport.kind === 'http' &&
          new URL(transport.endpoint).protocol !== 'https:' &&
          !['localhost', '127.0.0.1', '[::1]'].includes(new URL(transport.endpoint).hostname)) ||
        (transport.kind === 'stdio' &&
          binding.sink.kind === 'env' &&
          transport.environment[binding.sink.name]?.credentialSlot !== binding.slot)
      )
        throw new OperationError(
          'forbidden',
          'MCP preview credential binding is unavailable.',
          403
        );
      slots.add(binding.slot);
      sinks.add(sinkKey);
      authority(binding.vaultGrantId);
    }
    if (
      transport.kind === 'stdio' &&
      Object.entries(transport.environment).some(
        ([name, value]) =>
          !input.credentialBindings.some(
            (binding) =>
              binding.slot === value.credentialSlot &&
              binding.sink.kind === 'env' &&
              binding.sink.name === name
          )
      )
    )
      throw new OperationError(
        'forbidden',
        'MCP preview requires explicit credential bindings.',
        403
      );
    let packageRoot: string | undefined;
    if (source.version.packageRootDigest) {
      const plugin = source.catalog.plugins.versions.find(
        (candidate) => candidate.digest === source.version.packageRootDigest
      );
      if (!workspaceId || !plugin)
        throw new OperationError('not_found', 'MCP preview package is unavailable.', 404);
      packageRoot = resolveDataRootPath(
        dataRoot,
        'workspaces',
        workspaceId,
        'catalog',
        'plugin-snapshots',
        plugin.entryId,
        plugin.digest.slice('sha256:'.length)
      );
      if (!existsSync(packageRoot))
        throw new OperationError('not_found', 'MCP preview package is unavailable.', 404);
      if (
        digestOpenKitTree(packageRoot, { maxBytes: 64 * 1024 * 1024, maxEntries: 4096 }).digest !==
        source.version.packageRootDigest
      )
        throw new OperationError(
          'mcp_preview_unavailable',
          'MCP preview package integrity is unavailable.',
          503
        );
    }
    const audit = (outcome: 'succeeded' | 'failed', summary: string) =>
      recordServerAuditEvent({
        coreDb,
        actor: context.actorRef,
        workspaceId,
        requestId: previewId,
        action: 'administration.mcp-discovery-preview',
        resource: `mcp:${input.mcpId}`,
        outcome,
        summary,
      });
    audit(
      'succeeded',
      'Explicit temporary MCP discovery started; no tool execution is authorized.'
    );
    const gateway = createDefaultWorkerMcpGateway();
    let temporaryDirectory: string | undefined;
    let delivered = false;
    let cleanupProved = false;
    let failure: OperationError | undefined;
    let observation: OperationOutput<'administration.mcp-discovery-preview'> | undefined;
    const deadline = AbortSignal.timeout(input.timeoutMs);
    const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
    try {
      for (const binding of input.credentialBindings) {
        const { grant, reference } = authority(binding.vaultGrantId);
        const planId = randomUUID();
        createVaultInjectionPlan(coreDb, {
          planId,
          grantId: grant.grantId,
          capabilityId: 'mcp.list_tools',
          injectionVisibility: 'gateway-only',
          expirationBehavior: grant.expiresAt ? `expires-at:${grant.expiresAt}` : 'grant-lifetime',
          revocationBehavior: 'close-temporary-gateway-session',
          redactionRule: 'exact-resolved-material',
          backendCapabilityRequirement: `mcp-gateway:${transport.kind}`,
        });
        const db = workspaceId ? dependencies.repositoryWorkspaceDb?.(workspaceId) : coreDb;
        if (!db)
          throw new OperationError(
            'storage_unavailable',
            'MCP preview evidence is unavailable.',
            503
          );
        const material = createVaultUseAuditedBackend({
          backend: backend!,
          db,
          ownerScope: scope.kind,
          ...(workspaceId ? { workspaceId } : {}),
          actor: context.actorRef,
          resolvingPath: 'grant',
          grantId: grant.grantId,
          planId,
        }).resolve({ referenceId: reference.referenceId, version: reference.currentVersion });
        const value = vaultSecretMaterialToString(material);
        if (!value.length)
          throw new OperationError(
            'forbidden',
            'MCP preview credential material is unavailable.',
            403
          );
        if (binding.presentation === 'bearer') bearer = value;
        else if (binding.sink.kind === 'env') environment[binding.sink.name] = value;
        else if (binding.sink.kind === 'header') headers[binding.sink.name] = value;
        else query[binding.sink.name] = value;
        injections.push({
          grantId: grant.grantId,
          referenceId: reference.referenceId,
          version: reference.currentVersion,
          planId,
          receiptId: randomUUID(),
          injectedAt: new Date().toISOString(),
          expiresAt: grant.expiresAt,
        });
      }
      const credentials: WorkerMcpGatewayCredentials = {
        ...(bearer !== undefined ? { bearer } : {}),
        environment,
        headers,
        query,
      };
      if (transport.kind === 'stdio')
        temporaryDirectory = mkdtempSync(join(tmpdir(), 'openkit-mcp-preview-'));
      const connection: WorkerMcpGatewayServerInput = {
        workspaceId: workspaceId ?? 'server',
        server: {
          id: input.mcpId,
          ...(scope.kind === 'server' ? { scope: 'server' } : {}),
          transport,
          timeoutMs: input.timeoutMs,
          packageRootDigest: source.version.packageRootDigest,
          catalogDigest: source.version.digest,
        },
        credentials,
        signal,
        ...(temporaryDirectory
          ? {
              temporaryContext: {
                dataDirectory: temporaryDirectory,
                ...(packageRoot ? { packageRoot } : {}),
              },
            }
          : {}),
      };
      if (signal.aborted)
        throw new OperationError('mcp_preview_unavailable', 'MCP preview was interrupted.', 503);
      const live = await gateway.listTools(connection);
      delivered = true;
      current();
      for (const item of injections) {
        const now = authority(item.grantId);
        if (
          now.reference.referenceId !== item.referenceId ||
          now.reference.currentVersion !== item.version
        )
          throw new OperationError('forbidden', 'MCP preview material changed.', 403);
      }
      if (signal.aborted)
        throw new OperationError('mcp_preview_unavailable', 'MCP preview was interrupted.', 503);
      await gateway.close();
      cleanupProved = true;
      if (temporaryDirectory) {
        rmSync(temporaryDirectory, { recursive: true, force: true });
        temporaryDirectory = undefined;
      }
      current();
      for (const item of injections) {
        const now = authority(item.grantId);
        if (now.reference.currentVersion !== item.version)
          throw new OperationError('forbidden', 'MCP preview material changed.', 403);
      }
      const tools = live.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
      }));
      observation = {
        mcpId: input.mcpId,
        versionDigest: input.versionDigest,
        observedAt: new Date().toISOString(),
        serverVersion: live.serverVersion,
        tools,
      };
    } catch (error) {
      if (error instanceof WorkerMcpGatewayCallError && error.credentialsMaterialized)
        delivered = true;
      failure =
        error instanceof OperationError
          ? error
          : new OperationError(
              'mcp_preview_unavailable',
              'MCP preview failed. Upstream contact may have occurred.',
              503
            );
    }
    // Cleanup has its own outcome and cannot be hidden by either a successful list or an earlier refusal.
    try {
      if (!cleanupProved) {
        await gateway.close();
        cleanupProved = true;
      }
      if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    } catch {
      failure = new OperationError(
        'recovery_required',
        'MCP preview cleanup is unconfirmed. Inspect before another invocation.',
        409
      );
    }
    try {
      if (delivered)
        for (const item of injections) {
          const grant = getVaultGrant(coreDb, item.grantId);
          const reference = getVaultReference(coreDb, item.referenceId);
          createVaultInjectionReceipt(coreDb, {
            receiptId: item.receiptId,
            planId: item.planId,
            grantId: item.grantId,
            backendSummary: `mcp-gateway:${transport.kind}:preview`,
            injectedAt: item.injectedAt,
            expiresAt: item.expiresAt,
            revocationStatus:
              grant?.status !== 'active' || reference?.status !== 'active'
                ? 'revoked'
                : item.expiresAt && Date.parse(item.expiresAt) <= Date.now()
                  ? 'expired'
                  : 'active',
          });
        }
    } catch {
      failure = new OperationError(
        'recovery_required',
        'MCP preview delivery evidence is incomplete. Inspect before another invocation.',
        409
      );
    }
    if (signal.aborted && !failure)
      failure = new OperationError(
        'mcp_preview_unavailable',
        'MCP preview exceeded its deadline or was interrupted.',
        503
      );
    audit(
      failure ? 'failed' : 'succeeded',
      failure
        ? 'MCP discovery failed or was interrupted; inspect delivery evidence separately.'
        : 'Temporary MCP discovery completed and its connection closed; no tool executed.'
    );
    if (failure) throw failure;
    if (!observation)
      throw new OperationError('mcp_preview_unavailable', 'MCP preview is unavailable.', 503);
    return observation;
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError(
      'mcp_preview_unavailable',
      'MCP preview is unavailable. Inspect current state before a new invocation.',
      503
    );
  }
}
