import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  admitWorkerImageEnvironment,
  readAdmittedWorkerImageEnvironment,
  readWorkerImageSettlement,
  writeWorkerImageSettlement,
} from './worker-image-settlements.js';

const imageDigest = `sha256:${'d'.repeat(64)}`;
const environment = {
  imageDigest,
  defaultsDigest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  values: {},
};
const identity = {
  authoredArtifactId: 'ar_00000000-0000-7ce7-b2d8-9d02176fb5b5',
  authoredArtifactVersion: 1 as const,
  authoredContentDigest: `sha256:${'a'.repeat(64)}`,
  inputDigest: `sha256:${'b'.repeat(64)}`,
};
const settlement = {
  ...identity,
  requestId: '1'.repeat(64),
  operation: 'image.acquire' as const,
  outcome: { kind: 'success' as const, imageDigest },
};

describe('retained worker image settlement format', () => {
  it('writes v1 and reopens annotated environment bytes without rewriting them', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-image-settlement-v1-'));
    let db = openCoreDb(root);
    onTestFinished(() => {
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    applyMigrations(db);
    writeWorkerImageSettlement(db, settlement);
    admitWorkerImageEnvironment(db, identity, environment);
    const bytes = JSON.stringify({ ...environment, note: 'retained description' }, null, 2);
    db.sqlite.prepare('UPDATE worker_image_settlements SET native_environment_json = ?').run(bytes);
    expect(
      db.sqlite
        .prepare('SELECT schema_version AS schemaVersion FROM worker_image_settlements')
        .get()
    ).toEqual({ schemaVersion: 1 });
    db.sqlite.close();
    db = openCoreDb(root);
    expect(readWorkerImageSettlement(db, settlement.requestId)).toEqual(settlement);
    expect(readAdmittedWorkerImageEnvironment(db, imageDigest)).toEqual(environment);
    writeWorkerImageSettlement(db, settlement);
    admitWorkerImageEnvironment(db, identity, environment);
    expect(
      db.sqlite
        .prepare('SELECT native_environment_json AS bytes FROM worker_image_settlements')
        .get()
    ).toEqual({ bytes });
  });

  it('refuses an unknown version before malformed environment decode or replay effects', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-image-settlement-version-'));
    const db = openCoreDb(root);
    onTestFinished(() => {
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    applyMigrations(db);
    writeWorkerImageSettlement(db, settlement);
    db.sqlite.exec(
      "UPDATE worker_image_settlements SET schema_version = 2, native_environment_json = '{'"
    );
    const before = db.sqlite.serialize();
    expect(() => readWorkerImageSettlement(db, settlement.requestId)).toThrow(
      'Unsupported retained record format.'
    );
    expect(() => readAdmittedWorkerImageEnvironment(db, imageDigest)).toThrow(
      'Unsupported retained record format.'
    );
    expect(() => writeWorkerImageSettlement(db, settlement)).toThrow(
      'Unsupported retained record format.'
    );
    expect(() => admitWorkerImageEnvironment(db, identity, environment)).toThrow(
      'Unsupported retained record format.'
    );
    expect(db.sqlite.serialize().equals(before)).toBe(true);
  });
});
