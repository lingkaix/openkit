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
    id: 'wsexp_1',
    ownerScope: 'workspace',
    lineage: { workspaceId: 'ws_demo' },
    createdAt: timestamp,
    updatedAt: timestamp,
    contentDigest: 'sha256:manifest',
    redactionLevel: 'metadata',
    sensitivity: 'internal',
    requiredFeatures: [],
    extensions: {},
    sourceDeploymentId: 'dep_source',
    workspaceId: 'ws_demo',
    exportCreatedAt: timestamp,
    exportFormatVersion: 2,
    contentInventory: [
      {
        path: 'records/workspace.json',
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
      'records/workspace.json'
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
    id: 'drbak_1',
    ownerScope: 'server',
    lineage: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    contentDigest: 'sha256:manifest',
    redactionLevel: 'metadata',
    sensitivity: 'internal',
    requiredFeatures: [],
    extensions: {},
    sourceDeploymentId: 'dep_source',
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
