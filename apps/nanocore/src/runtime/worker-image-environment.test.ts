import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalNativeEnvironment } from '@openkit/worker-protocol';
import { describe, expect, it } from 'vitest';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { disposeTestStore } from '../test-support/store.js';
import {
  admitWorkerImageEnvironment,
  readAdmittedWorkerImageEnvironment,
  WorkerImageSettlementConflict,
  writeWorkerImageSettlement,
} from './worker-image-settlements.js';

const imageDigest = `sha256:${'d'.repeat(64)}`;
const defaultsDigest = 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
const candidate = {
  authoredArtifactId: 'ar_00000000-0000-7ce7-b2d8-9d02176fb5b5',
  authoredArtifactVersion: 1 as const,
  authoredContentDigest: `sha256:${'a'.repeat(64)}`,
  inputDigest: `sha256:${'b'.repeat(64)}`,
};

describe('confirmed image environment settlement', () => {
  it('withholds defaults until exact confirmation and carries admission across restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-native-env-'));
    let db = openCoreDb(root);
    try {
      applyMigrations(db);
      expect(readAdmittedWorkerImageEnvironment(db, imageDigest)).toBeNull();
      await expect(
        async () =>
          await admitWorkerImageEnvironment(db, candidate, {
            imageDigest,
            defaultsDigest,
            values: {},
          })
      ).rejects.toThrow(WorkerImageSettlementConflict);
      await writeWorkerImageSettlement(db, {
        ...candidate,
        requestId: '1'.repeat(64),
        operation: 'image.acquire',
        outcome: { kind: 'success', imageDigest },
      });
      expect(readAdmittedWorkerImageEnvironment(db, imageDigest)).toBeNull();
      await expect(
        async () =>
          await admitWorkerImageEnvironment(
            db,
            { ...candidate, authoredContentDigest: `sha256:${'c'.repeat(64)}` },
            { imageDigest, defaultsDigest, values: {} }
          )
      ).rejects.toThrow(WorkerImageSettlementConflict);
      await expect(
        async () =>
          await admitWorkerImageEnvironment(db, candidate, {
            imageDigest,
            defaultsDigest,
            values: { CHANGED: 'x' },
          })
      ).rejects.toThrow();
      expect(readAdmittedWorkerImageEnvironment(db, imageDigest)).toBeNull();
      await admitWorkerImageEnvironment(db, candidate, { imageDigest, defaultsDigest, values: {} });
      db.sqlite.close();
      db = openCoreDb(root);
      expect(readAdmittedWorkerImageEnvironment(db, imageDigest)).toEqual({
        imageDigest,
        defaultsDigest,
        values: {},
      });
      await expect(
        async () =>
          await admitWorkerImageEnvironment(db, candidate, {
            imageDigest,
            defaultsDigest,
            values: { CHANGED: 'x' },
          })
      ).rejects.toThrow();
      const extended = JSON.stringify(
        { imageDigest, defaultsDigest, values: {}, note: 'inert future metadata' },
        null,
        2
      );
      db.sqlite
        .prepare(
          'UPDATE worker_image_settlements SET native_environment_json = ? WHERE request_id = ?'
        )
        .run(extended, '1'.repeat(64));
      await admitWorkerImageEnvironment(db, candidate, { imageDigest, defaultsDigest, values: {} });
      expect(
        db.sqlite
          .prepare(
            'SELECT native_environment_json AS bytes FROM worker_image_settlements WHERE request_id = ?'
          )
          .get('1'.repeat(64))
      ).toEqual({ bytes: extended });
    } finally {
      await disposeTestStore(root, db);
    }
  });
  it('refuses conflicting second admission before writing and revalidates durable bytes on read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-native-env-conflict-'));
    const db = openCoreDb(root);
    try {
      applyMigrations(db);
      const second = {
        ...candidate,
        authoredArtifactId: 'ar_00000000-0000-7715-a7ab-a9e022886a62',
      };
      await writeWorkerImageSettlement(db, {
        ...candidate,
        requestId: '1'.repeat(64),
        operation: 'image.acquire',
        outcome: { kind: 'success', imageDigest },
      });
      await admitWorkerImageEnvironment(db, candidate, { imageDigest, defaultsDigest, values: {} });
      await writeWorkerImageSettlement(db, {
        ...second,
        requestId: '2'.repeat(64),
        operation: 'image.acquire',
        outcome: { kind: 'success', imageDigest },
      });
      const values = { CHANGED: 'literal' };
      const changedDigest = `sha256:${createHash('sha256').update(canonicalNativeEnvironment(values)).digest('hex')}`;
      await expect(
        async () =>
          await admitWorkerImageEnvironment(db, second, {
            imageDigest,
            defaultsDigest: changedDigest,
            values,
          })
      ).rejects.toThrow();
      expect(
        db.sqlite
          .prepare(
            'SELECT native_environment_json AS environment FROM worker_image_settlements WHERE request_id = ?'
          )
          .get('2'.repeat(64))
      ).toEqual({ environment: null });
      db.sqlite
        .prepare(
          'UPDATE worker_image_settlements SET native_environment_json = ? WHERE request_id = ?'
        )
        .run(
          JSON.stringify({ imageDigest: `sha256:${'e'.repeat(64)}`, defaultsDigest, values: {} }),
          '1'.repeat(64)
        );
      expect(() => readAdmittedWorkerImageEnvironment(db, imageDigest)).toThrow();
      db.sqlite
        .prepare(
          'UPDATE worker_image_settlements SET native_environment_json = ? WHERE request_id = ?'
        )
        .run(
          JSON.stringify({ imageDigest, defaultsDigest, values: { CHANGED: 'x' } }),
          '1'.repeat(64)
        );
      expect(() => readAdmittedWorkerImageEnvironment(db, imageDigest)).toThrow();
    } finally {
      await disposeTestStore(root, db);
    }
  });
});
