import type { WorkspaceDb } from '../storage/db.js';
import type { ResolvedAgentSetup } from './setup-resolver.js';

/** Deliberate non-secret projection of the setup facts needed for durable evidence. */
export interface RedactedResolvedAgentSetup {
  /** Selected manifest facts that determined runtime and sandbox policy. */
  readonly manifest: {
    /** Selected agent id. */
    readonly id: string;
    /** Required feature ids used during setup resolution. */
    readonly requiredFeatures: string[];
    /** Exact runtime, image, and binary declarations. */
    readonly runtime: ResolvedAgentSetup['manifest']['runtime'];
    /** Exact network and non-secret credential declaration metadata. */
    readonly sandbox: {
      /** Credential declaration metadata without resolved values. */
      readonly credentialDeclarations: NonNullable<
        ResolvedAgentSetup['manifest']['sandbox']
      >['credentialDeclarations'];
      /** Exact authored network grants. */
      readonly network: NonNullable<ResolvedAgentSetup['manifest']['sandbox']>['network'];
    };
  };
  /** Exact logical model contract exposed to the selected worker. */
  readonly logicalModels: {
    readonly preferredLogicalModelId: string;
    readonly allowed: Array<{
      readonly id: string;
      readonly capabilities: readonly string[];
      readonly modelFamilyId: string;
    }>;
  };
}

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

/** Input for recording one resolved setup. */
export interface RecordResolvedAgentSetupInput {
  /** Durable setup record id. */
  readonly recordId: string;
  /** Workspace that owns the record. */
  readonly workspaceId: string;
  /** Turn that used this setup, when known. */
  readonly turnId?: string | null;
  /** Request that produced this setup, when known. */
  readonly requestId?: string | null;
  /** Resolved setup to persist. */
  readonly setup: ResolvedAgentSetup;
  /** Creation timestamp. */
  readonly createdAt: string;
}

interface ResolvedAgentSetupRow {
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
 * Persists one redacted resolved agent setup in the workspace ledger.
 *
 * @param workspaceDb Open workspace database.
 * @param input Resolved setup record input.
 * @returns Stored record.
 */
export function recordResolvedAgentSetup(
  workspaceDb: WorkspaceDb,
  input: RecordResolvedAgentSetupInput
): ResolvedAgentSetupRecord {
  const redactedSetup = redactResolvedAgentSetup(input.setup);

  workspaceDb.sqlite
    .prepare(
      `INSERT OR REPLACE INTO resolved_agent_setups (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.recordId,
      input.workspaceId,
      input.turnId ?? null,
      input.requestId ?? null,
      input.setup.manifest.id,
      input.setup.logicalModels.preferredLogicalModelId,
      input.setup.manifest.runtime.kind,
      input.setup.manifest.runtime.adapter,
      JSON.stringify(input.setup.manifest.requiredFeatures),
      JSON.stringify(redactedSetup),
      input.createdAt
    );

  return requireResolvedAgentSetup(workspaceDb, input.workspaceId, input.recordId);
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
 * Replays exported resolved setup records through the same redacted projection.
 *
 * @param workspaceDb Open target workspace database.
 * @param records Exported records already rewritten to the target workspace id.
 */
export function importResolvedAgentSetups(
  workspaceDb: WorkspaceDb,
  records: readonly ResolvedAgentSetupRecord[]
): void {
  const insert = workspaceDb.sqlite.prepare(
    `INSERT OR IGNORE INTO resolved_agent_setups (
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const record of records) {
    insert.run(
      record.id,
      record.workspaceId,
      record.turnId,
      record.requestId,
      record.agentId,
      record.logicalModelId,
      record.runtimeKind,
      record.runtimeAdapter,
      JSON.stringify(record.requiredFeatures),
      JSON.stringify(redactResolvedAgentSetup(record.setup)),
      record.createdAt
    );
  }
}

/**
 * Maps one database row to a resolved setup record.
 *
 * @param row Resolved setup row.
 * @returns Parsed resolved setup record.
 */
function resolvedAgentSetupFromRow(row: ResolvedAgentSetupRow): ResolvedAgentSetupRecord {
  const setup = JSON.parse(row.setup_json) as ResolvedAgentSetup | RedactedResolvedAgentSetup;

  return {
    id: row.setup_record_id,
    workspaceId: row.workspace_id,
    turnId: row.turn_id,
    requestId: row.request_id,
    agentId: row.agent_id,
    logicalModelId: row.logical_model_id,
    runtimeKind: row.runtime_kind,
    runtimeAdapter: row.runtime_adapter,
    requiredFeatures: JSON.parse(row.required_features_json) as string[],
    setup: redactResolvedAgentSetup(setup),
    createdAt: row.created_at,
  };
}

/**
 * Projects one complete resolved setup to its durable non-secret evidence shape.
 *
 * @param setup Complete launch setup or supplied redacted import projection.
 * @returns Whitelisted runtime, sandbox-policy, and provider decision facts.
 */
function redactResolvedAgentSetup(
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
