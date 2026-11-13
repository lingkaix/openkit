import { readRetainedV1 } from '@openkit/protocol';
import type { z } from 'zod';
import type { WorkspaceDb } from '../storage/db.js';
import type { ResolvedAgentSetup } from './setup-resolver.js';
import {
  StoredResolvedAgentSetupV1Schema,
  StoredSetupRequiredFeaturesV1Schema,
} from './setup-retained-v1.js';

/** Deliberate non-secret evidence shape, independent of the current launch manifest. */
export type RedactedResolvedAgentSetup = z.infer<typeof StoredResolvedAgentSetupV1Schema>;

/** Durable workspace-scoped resolved setup record. */
export interface ResolvedAgentSetupRecord {
  /** Durable setup record id. */
  readonly id: string;
  /** Workspace that owns the record. */
  readonly workspaceId: string;
  /** Turn that used this setup, when known. */
  readonly turnId: string | null;
  /** Request that produced this setup, when known. */
  readonly requestId: string | null;
  /** Resolved agent id. */
  readonly agentId: string;
  /** Preferred worker-visible logical model id. */
  readonly logicalModelId: string;
  /** Runtime family. */
  readonly runtimeKind: string;
  /** Runtime adapter id. */
  readonly runtimeAdapter: string;
  /** Required feature ids preserved by resolution. */
  readonly requiredFeatures: string[];
  /** Redacted resolved setup payload. */
  readonly setup: RedactedResolvedAgentSetup;
  /** Creation timestamp. */
  readonly createdAt: string;
}

interface ResolvedAgentSetupRow {
  readonly schemaVersion: unknown;
  readonly setup_record_id: string;
  readonly workspace_id: string;
  readonly turn_id: string | null;
  readonly request_id: string | null;
  readonly agent_id: string;
  readonly logical_model_id: string;
  readonly runtime_kind: string;
  readonly runtime_adapter: string;
  readonly required_features_json: string;
  readonly setup_json: string;
  readonly created_at: string;
}

/**
 * Reads one resolved setup record or throws when missing.
 *
 * @param workspaceDb Open workspace database.
 * @param workspaceId Workspace id.
 * @param recordId Setup record id.
 * @returns Stored record.
 */
export function requireResolvedAgentSetup(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  recordId: string
): ResolvedAgentSetupRecord {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT
        schema_version AS schemaVersion,
        setup_record_id,
        workspace_id,
        turn_id,
        request_id,
        agent_id,
        logical_model_id,
        runtime_kind,
        runtime_adapter,
        required_features_json,
        setup_json,
        created_at
       FROM resolved_agent_setups
       WHERE workspace_id = ? AND setup_record_id = ?`
    )
    .get(workspaceId, recordId) as ResolvedAgentSetupRow | undefined;

  if (!row) {
    throw new Error(`Resolved agent setup not found: ${recordId}`);
  }

  return resolvedAgentSetupFromRow(row);
}

/**
 * Lists resolved setup records for workspace export.
 *
 * @param workspaceDb Open workspace database.
 * @param workspaceId Workspace id.
 * @returns Exportable setup records in stable storage order.
 */
export function listExportableResolvedAgentSetups(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): ResolvedAgentSetupRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT
          schema_version AS schemaVersion,
          setup_record_id,
          workspace_id,
          turn_id,
          request_id,
          agent_id,
          logical_model_id,
          runtime_kind,
          runtime_adapter,
          required_features_json,
          setup_json,
          created_at
         FROM resolved_agent_setups
         WHERE workspace_id = ?
         ORDER BY created_at ASC, setup_record_id ASC`
      )
      .all(workspaceId) as ResolvedAgentSetupRow[]
  ).map(resolvedAgentSetupFromRow);
}

/**
 * Maps one database row to a resolved setup record.
 *
 * @param row Resolved setup row.
 * @returns Parsed resolved setup record.
 */
function resolvedAgentSetupFromRow(row: ResolvedAgentSetupRow): ResolvedAgentSetupRecord {
  return readRetainedV1(row, () => ({
    id: row.setup_record_id,
    workspaceId: row.workspace_id,
    turnId: row.turn_id,
    requestId: row.request_id,
    agentId: row.agent_id,
    logicalModelId: row.logical_model_id,
    runtimeKind: row.runtime_kind,
    runtimeAdapter: row.runtime_adapter,
    requiredFeatures: StoredSetupRequiredFeaturesV1Schema.parse(
      JSON.parse(row.required_features_json)
    ),
    setup: redactResolvedAgentSetup(
      StoredResolvedAgentSetupV1Schema.parse(JSON.parse(row.setup_json))
    ),
    createdAt: row.created_at,
  }));
}

/** Validates the existing primary-key owner before replacement or an ignored import collision. */
export function guardExistingResolvedAgentSetup(workspaceDb: WorkspaceDb, recordId: string): void {
  const row = workspaceDb.sqlite
    .prepare(
      'SELECT *, schema_version AS schemaVersion FROM resolved_agent_setups WHERE setup_record_id = ?'
    )
    .get(recordId) as ResolvedAgentSetupRow | undefined;
  if (row) resolvedAgentSetupFromRow(row);
}

/**
 * Projects one complete resolved setup to its durable non-secret evidence shape.
 *
 * @param setup Complete launch setup or supplied redacted import projection.
 * @returns Whitelisted runtime, sandbox-policy, and provider decision facts.
 */
export function redactResolvedAgentSetup(
  setup: ResolvedAgentSetup | RedactedResolvedAgentSetup
): RedactedResolvedAgentSetup {
  const { manifest } = setup;

  return {
    manifest: {
      id: manifest.id,
      requiredFeatures: [...manifest.requiredFeatures],
      runtime: {
        adapter: manifest.runtime.adapter,
        binaries: manifest.runtime.binaries.map((binary) => ({
          id: binary.id,
          path: binary.path,
        })),
        image:
          manifest.runtime.image.kind === 'reference'
            ? { ...manifest.runtime.image }
            : {
                ...manifest.runtime.image,
                arguments: { ...manifest.runtime.image.arguments },
                egress: manifest.runtime.image.egress.map((destination) => ({ ...destination })),
                input: { ...manifest.runtime.image.input },
              },
        kind: manifest.runtime.kind,
        ...(manifest.runtime.version ? { version: manifest.runtime.version } : {}),
      },
      sandbox: {
        credentialDeclarations: (manifest.sandbox?.credentialDeclarations ?? []).map(
          (declaration) => {
            if (declaration.visibility === 'sandbox-provider') {
              return {
                id: declaration.id,
                ...(declaration.requirementId ? { requirementId: declaration.requirementId } : {}),
                provider: {
                  credentialKey: declaration.provider.credentialKey,
                  instanceId: declaration.provider.instanceId,
                  profileId: declaration.provider.profileId,
                  type: declaration.provider.type,
                },
                vaultGrantId: declaration.vaultGrantId,
                visibility: declaration.visibility,
              };
            }
            if (declaration.visibility === 'runtime-file') {
              return {
                id: declaration.id,
                ...(declaration.requirementId ? { requirementId: declaration.requirementId } : {}),
                targetPath: declaration.targetPath,
                vaultGrantId: declaration.vaultGrantId,
                visibility: declaration.visibility,
              };
            }
            if (
              declaration.visibility === 'runtime-token' &&
              declaration.consumer === 'credential-helper'
            ) {
              const helper = declaration.helper;
              const target =
                helper.protocol === 'git'
                  ? {
                      protocol: helper.protocol,
                      scheme: helper.scheme,
                      host: helper.host,
                      ...(helper.path === undefined ? {} : { path: helper.path }),
                    }
                  : helper.protocol === 'docker'
                    ? { protocol: helper.protocol, serverUrl: helper.serverUrl }
                    : helper.protocol === 'aws'
                      ? { protocol: helper.protocol }
                      : helper.protocol === 'kubernetes'
                        ? { protocol: helper.protocol, apiVersion: helper.apiVersion }
                        : {
                            protocol: helper.protocol,
                            audience: helper.audience,
                            subjectTokenType: helper.subjectTokenType,
                          };
              return {
                id: declaration.id,
                ...(declaration.requirementId ? { requirementId: declaration.requirementId } : {}),
                visibility: declaration.visibility,
                vaultGrantId: declaration.vaultGrantId,
                consumer: declaration.consumer,
                helper: target,
              };
            }
            if (declaration.visibility === 'external-handle') {
              return {
                id: declaration.id,
                ...(declaration.requirementId ? { requirementId: declaration.requirementId } : {}),
                visibility: declaration.visibility,
                vaultGrantId: declaration.vaultGrantId,
                consumer: declaration.consumer,
              };
            }
            if (declaration.visibility === 'runtime-token') {
              return {
                visibility: declaration.visibility,
                requirementId: declaration.requirementId,
                vaultGrantId: declaration.vaultGrantId,
                consumer: declaration.consumer,
              };
            }
            return {
              id: declaration.id,
              ...(declaration.requirementId ? { requirementId: declaration.requirementId } : {}),
              targetEnvVarName: declaration.targetEnvVarName,
              vaultGrantId: declaration.vaultGrantId,
              visibility: declaration.visibility,
            };
          }
        ),
        network: (manifest.sandbox?.network ?? []).map((grant) => ({
          binaries: [...(grant.binaries ?? [])],
          host: grant.host,
          ...('allowEncodedSlash' in grant && grant.allowEncodedSlash !== undefined
            ? { allowEncodedSlash: grant.allowEncodedSlash }
            : {}),
          id: grant.id,
          port: grant.port,
          purpose: grant.purpose,
          ...('rules' in grant && grant.rules
            ? { protocol: 'rest' as const, rules: grant.rules.map((rule) => ({ ...rule })) }
            : { access: grant.access, protocol: grant.protocol }),
          scope: grant.scope,
        })),
      },
    },
    logicalModels: {
      preferredLogicalModelId: setup.logicalModels.preferredLogicalModelId,
      allowed: setup.logicalModels.allowed.map((model) => ({
        id: model.id,
        capabilities: [...model.capabilities],
        modelFamilyId: model.modelFamilyId,
      })),
    },
  };
}
