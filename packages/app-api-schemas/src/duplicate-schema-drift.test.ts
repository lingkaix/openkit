import {
  AgentEnvironmentBuildEgressSchema,
  LightAppDefinitionVersionRecordSchema,
  SkillCandidateRecordSchema,
  SkillEntryRecordSchema,
  SkillVersionRecordSchema,
  WorkspaceMcpToolNameSchema,
} from '@openkit/config-schema';
import {
  DataRootBackupManifestSchema as OwnerDataRootBackupManifestSchema,
  WorkspaceExportManifestSchema as OwnerWorkspaceExportManifestSchema,
} from '@openkit/config-schema/workspace-export';
import { describe, expect, it } from 'vitest';
import { LightAppDefinitionVersionSchema } from './light-app-definitions.js';
import {
  CreateMcpConfigRequestSchema,
  McpCatalogEntrySchema,
  SkillCatalogCandidateSchema,
  SkillCatalogEntrySchema,
  SkillCatalogVersionSchema,
  UpdateMcpBindingRequestSchema,
} from './resource-catalog.js';
import { DataRootBackupManifestSchema, WorkspaceExportManifestSchema } from './storage.js';
import { WorkerEnvironmentImageDeclarationSchema } from './worker-environment.js';

const timestamp = '2026-10-01T10:00:00.000Z';
const digest = `sha256:${'a'.repeat(64)}`;
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const requestId = '11111111-1111-4111-8111-111111111111';
const producer = { id: 'user-1', kind: 'user' as const };

function exportManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    recordType: 'workspace-export',
    id: 'wsexp_00000000-0000-7569-b23e-40ca1402f214',
    ownerScope: 'workspace',
    lineage: { workspaceId },
    createdAt: timestamp,
    updatedAt: timestamp,
    contentDigest: 'sha256:manifest',
    redactionLevel: 'metadata',
    sensitivity: 'internal',
    requiredFeatures: [],
    extensions: {},
    sourceDeploymentId: 'dep_00000000-0000-7737-8fe7-61ca07c79d45',
    workspaceId,
    exportCreatedAt: timestamp,
    exportFormatVersion: 3,
    contentInventory: [
      {
        path: 'records/workspace-record.json',
        digest,
        bytes: 1,
      },
    ],
    ...overrides,
  };
}

function backupManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    recordType: 'data-root-backup',
    id: 'drb_00000000-0000-72d0-89a7-67474a8170db',
    ownerScope: 'server',
    lineage: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    contentDigest: 'sha256:manifest',
    redactionLevel: 'metadata',
    sensitivity: 'internal',
    requiredFeatures: [],
    extensions: {},
    sourceDeploymentId: 'dep_00000000-0000-7737-8fe7-61ca07c79d45',
    backupStartedAt: timestamp,
    backupCompletedAt: timestamp,
    backupMode: 'cold',
    consistency: 'clean',
    backupFormatVersion: 1,
    contentInventory: [
      {
        path: 'server/layout.json',
        digest,
        bytes: 1,
      },
    ],
    ...overrides,
  };
}

function buildDeclaration(host: string) {
  return {
    arguments: {},
    contextDigest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    contextRef: 'build-context://empty/v1',
    egress: [{ host, port: 443 }],
    input: { content: 'FROM node:24\n', digest, kind: 'dockerfile' as const },
    kind: 'build' as const,
    layerLimit: 16,
    outputLimitBytes: 1_073_741_824,
    timeLimitSeconds: 600,
  };
}

function definitionVersion(definitionJson: string) {
  return {
    entryId: 'notes',
    digest,
    parentDigest: null,
    producer,
    createdAt: timestamp,
    definitionJson,
  };
}

const skillProvenance = {
  baseDigest: null,
  pluginMemberKey: null,
  pluginVersionDigest: null,
  sourceCommit: null,
  sourceSubpath: null,
  uploadedSourceId: null,
};

describe('GB-DUP2-01 workspace export and backup manifests', () => {
  it('refuses traversal paths and accepts offset timestamps on both copies', () => {
    const traversal = exportManifest({
      contentInventory: [{ path: '../secret', digest, bytes: 1 }],
    });
    expect(OwnerWorkspaceExportManifestSchema.safeParse(traversal).success).toBe(false);
    expect(WorkspaceExportManifestSchema.safeParse(traversal).success).toBe(false);

    const offset = exportManifest({ createdAt: '2026-10-01T10:00:00+02:00' });
    expect(OwnerWorkspaceExportManifestSchema.safeParse(offset).success).toBe(true);
    expect(WorkspaceExportManifestSchema.safeParse(offset).success).toBe(true);

    const extraLineage = exportManifest({
      lineage: { workspaceId, turnId: 'tu_00000000-0000-7000-8000-000000000001' },
    });
    expect(OwnerWorkspaceExportManifestSchema.safeParse(extraLineage).success).toBe(true);
    expect(WorkspaceExportManifestSchema.safeParse(extraLineage).success).toBe(true);
  });

  it('refuses cold crash-consistent backups on both copies', () => {
    const invalid = backupManifest({ backupMode: 'cold', consistency: 'crash-consistent' });
    expect(OwnerDataRootBackupManifestSchema.safeParse(invalid).success).toBe(false);
    expect(DataRootBackupManifestSchema.safeParse(invalid).success).toBe(false);

    const ordered = backupManifest({
      backupStartedAt: '2026-10-01T11:00:00.000Z',
      backupCompletedAt: timestamp,
    });
    expect(OwnerDataRootBackupManifestSchema.safeParse(ordered).success).toBe(false);
    expect(DataRootBackupManifestSchema.safeParse(ordered).success).toBe(false);
  });
});

describe('GB-DUP2-02 worker environment egress host', () => {
  it('accepts only hostname or IP egress hosts on both copies', () => {
    const urlHost = 'https://registry.npmjs.org/path';
    expect(
      AgentEnvironmentBuildEgressSchema.safeParse([{ host: urlHost, port: 443 }]).success
    ).toBe(false);
    expect(
      WorkerEnvironmentImageDeclarationSchema.safeParse(buildDeclaration(urlHost)).success
    ).toBe(false);
    expect(
      AgentEnvironmentBuildEgressSchema.safeParse([{ host: 'registry.npmjs.org', port: 443 }])
        .success
    ).toBe(true);
    expect(
      WorkerEnvironmentImageDeclarationSchema.safeParse(buildDeclaration('registry.npmjs.org'))
        .success
    ).toBe(true);
    expect(
      WorkerEnvironmentImageDeclarationSchema.safeParse(buildDeclaration('127.0.0.1')).success
    ).toBe(true);
  });
});

describe('GB-DUP2-03 light app definitionJson', () => {
  it('refuses empty and over-256-KiB UTF-8 definition bytes on both copies', () => {
    const empty = definitionVersion('');
    expect(LightAppDefinitionVersionRecordSchema.safeParse(empty).success).toBe(false);
    expect(LightAppDefinitionVersionSchema.safeParse(empty).success).toBe(false);

    const oversized = definitionVersion('é'.repeat(131_073));
    expect(LightAppDefinitionVersionRecordSchema.safeParse(oversized).success).toBe(false);
    expect(LightAppDefinitionVersionSchema.safeParse(oversized).success).toBe(false);

    const accepted = definitionVersion('{}');
    expect(LightAppDefinitionVersionRecordSchema.safeParse(accepted).success).toBe(true);
    expect(LightAppDefinitionVersionSchema.safeParse(accepted).success).toBe(true);
  });
});

describe('GB-DUP2-04 catalog tool names and skill bounds', () => {
  it('refuses whitespace and over-long MCP tool names on both copies', () => {
    for (const name of [' tool ', 'x'.repeat(257)]) {
      expect(WorkspaceMcpToolNameSchema.safeParse(name).success).toBe(false);
      expect(
        CreateMcpConfigRequestSchema.safeParse({
          allowedTools: [name],
          declaration: { kind: 'stdio', command: 'echo' },
          displayName: 'Example',
          expectedRevision: 0,
          requestId,
        }).success
      ).toBe(false);
      expect(
        UpdateMcpBindingRequestSchema.safeParse({
          allowedTools: [name],
          bindingRevision: 1,
          enabled: true,
          expectedRevision: 2,
          requestId,
          schemaPolicy: 'tracking',
        }).success
      ).toBe(false);
      expect(
        McpCatalogEntrySchema.safeParse({
          allowedTools: [name],
          availability: 'available',
          bindingRevision: 1,
          currentVersionDigest: digest,
          displayName: 'Echo',
          enabled: true,
          id: 'echo',
          schemaPolicy: 'tracking',
          timeoutMs: 2000,
          transportKind: 'http',
          versions: [],
        }).success
      ).toBe(false);
    }

    expect(WorkspaceMcpToolNameSchema.safeParse('search').success).toBe(true);
    expect(
      CreateMcpConfigRequestSchema.safeParse({
        allowedTools: ['search'],
        declaration: { kind: 'stdio', command: 'echo' },
        displayName: 'Example',
        expectedRevision: 0,
        requestId,
      }).success
    ).toBe(true);
  });

  it('matches owner skill description, publisher version, and summary bounds', () => {
    const entry = {
      availability: 'available' as const,
      currentDigest: null,
      description: '',
      displayName: 'Deploy',
      id: 'deploy-helper',
    };
    expect(SkillEntryRecordSchema.safeParse(entry).success).toBe(false);
    expect(SkillCatalogEntrySchema.safeParse(entry).success).toBe(false);

    const version = {
      contentState: 'retained' as const,
      createdAt: timestamp,
      digest,
      digestFormat: 'openkit-tree-v1' as const,
      entryId: 'deploy-helper',
      inventory: [],
      producer,
      provenance: skillProvenance,
      publisherVersion: '',
    };
    expect(SkillVersionRecordSchema.safeParse(version).success).toBe(false);
    expect(SkillCatalogVersionSchema.safeParse(version).success).toBe(false);

    const candidate = {
      baseDigest: null,
      candidateDigest: digest,
      createdAt: timestamp,
      decision: null,
      disposition: 'proposed' as const,
      entryId: 'deploy-helper',
      id: 'cand_01890f3e-0000-7000-8000-000000000001',
      producer,
      submitter: null,
      summary: 'x'.repeat(4097),
    };
    expect(SkillCandidateRecordSchema.safeParse(candidate).success).toBe(false);
    expect(SkillCatalogCandidateSchema.safeParse(candidate).success).toBe(false);
  });
});
