import { describe, expect, it } from 'vitest';

import {
  DataRootBackupManifestSchema,
  parseDataRootBackupManifest,
  parseWorkspaceExportManifest,
  WorkspaceExportManifestSchema,
} from './workspace-export.js';

const timestamp = '2026-07-05T00:00:00.000Z';

/**
 * Returns one valid workspace export manifest fixture.
 *
 * @returns Manifest fixture.
 */
function manifest() {
  return {
    schemaVersion: 1,
    recordType: 'workspace-export',
    id: 'wsexp_00000000-0000-7569-b23e-40ca1402f214',
    ownerScope: 'workspace',
    lineage: { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
    createdAt: timestamp,
    updatedAt: timestamp,
    contentDigest: 'sha256:manifest',
    redactionLevel: 'metadata',
    sensitivity: 'internal',
    requiredFeatures: [],
    extensions: {},
    sourceDeploymentId: 'dep_00000000-0000-7737-8fe7-61ca07c79d45',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    exportCreatedAt: timestamp,
    exportFormatVersion: 3,
    contentInventory: [
      {
        path: 'records/workspace-record.json',
        digest: 'sha256:ab4a13e5a040b76a82521f52dabddd42e7e4d4244c47e16ee8c6e1aa16233f3f',
        bytes: 42,
      },
    ],
  };
}

describe('workspace export manifest schema', () => {
  it('parses the current workspace-export manifest shape', () => {
    expect(WorkspaceExportManifestSchema.parse(manifest()).recordType).toBe('workspace-export');
    expect(parseWorkspaceExportManifest(manifest()).contentInventory[0]?.path).toBe(
      'records/workspace-record.json'
    );
  });

  it('rejects unsupported required features by name', () => {
    const candidate = {
      ...manifest(),
      requiredFeatures: ['workspace.mount.fuse'],
    };

    expect(() => parseWorkspaceExportManifest(candidate)).toThrow(
      'Unsupported required feature: workspace.mount.fuse'
    );
    expect(
      parseWorkspaceExportManifest(candidate, {
        supportedFeatures: ['workspace.mount.fuse'],
      }).requiredFeatures
    ).toEqual(['workspace.mount.fuse']);
  });

  it('rejects unsafe inventory paths', () => {
    expect(() =>
      WorkspaceExportManifestSchema.parse({
        ...manifest(),
        contentInventory: [
          {
            path: '../secret.txt',
            digest: 'sha256:ab4a13e5a040b76a82521f52dabddd42e7e4d4244c47e16ee8c6e1aa16233f3f',
            bytes: 1,
          },
        ],
      })
    ).toThrow();
    expect(() =>
      WorkspaceExportManifestSchema.parse({
        ...manifest(),
        contentInventory: [
          {
            path: '/secret.txt',
            digest: 'sha256:ab4a13e5a040b76a82521f52dabddd42e7e4d4244c47e16ee8c6e1aa16233f3f',
            bytes: 1,
          },
        ],
      })
    ).toThrow();
  });
});

/**
 * Returns one valid data-root backup manifest fixture.
 *
 * @returns Manifest fixture.
 */
function backupManifest() {
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
        digest: 'sha256:ab4a13e5a040b76a82521f52dabddd42e7e4d4244c47e16ee8c6e1aa16233f3f',
        bytes: 42,
      },
    ],
  };
}

describe('data-root backup manifest schema', () => {
  it('parses the accepted first-slice data-root-backup manifest shape', () => {
    expect(DataRootBackupManifestSchema.parse(backupManifest()).recordType).toBe(
      'data-root-backup'
    );
    expect(parseDataRootBackupManifest(backupManifest()).contentInventory[0]?.path).toBe(
      'server/layout.json'
    );
  });

  it('rejects unsupported required features by name', () => {
    const candidate = {
      ...backupManifest(),
      requiredFeatures: ['workspace.mount.fuse'],
    };

    expect(() => parseDataRootBackupManifest(candidate)).toThrow(
      'Unsupported required feature: workspace.mount.fuse'
    );
  });

  it('rejects inconsistent cold backup manifests', () => {
    expect(() =>
      DataRootBackupManifestSchema.parse({
        ...backupManifest(),
        consistency: 'crash-consistent',
      })
    ).toThrow('Cold backups must be clean.');
  });
});
