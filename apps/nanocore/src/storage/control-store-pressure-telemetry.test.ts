import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { CONTROL_STORE_BUDGET, controlStoreFor } from './control-store.js';
import {
  ControlStorePressureTelemetry,
  recordObservationBodyGrowth,
} from './control-store-pressure-telemetry.js';

const pressure = {
  walBytes: CONTROL_STORE_BUDGET.checkpointBytes,
  walAgeMs: CONTROL_STORE_BUDGET.checkpointAgeMs,
  checkpointAgeMs: 2_000,
  queued: 7,
  open: 3,
};

it('samples bounded committed latency and physical body growth on the exact observation owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-pressure-'));
  const path = join(root, 'state.sqlite');
  const sqlite = new Database(path);
  const sibling = new Database(':memory:');
  try {
    const owner = controlStoreFor(sqlite);
    owner.write((db) => db.exec('CREATE TABLE witness (value INTEGER)'));
    expect(owner.lastCommitMs).toBeGreaterThanOrEqual(0);
    expect(owner.checkpointAgeMs).toBeNull();
    expect(owner.checkpoint()).toMatchObject({ busy: 0 });
    expect(owner.checkpointAgeMs).toBeGreaterThanOrEqual(0);
    const emit = vi.fn();
    const telemetry = new ControlStorePressureTelemetry(
      sqlite,
      path,
      {
        scope: 'workspace',
        'openkit.workspace.id': 'ws_00000000-0000-7000-8000-000000000001',
      },
      emit
    );
    for (let index = 0; index < 130; index++) telemetry.observe(index, 0, index, () => pressure);
    recordObservationBodyGrowth(sqlite, 52);
    recordObservationBodyGrowth(sibling, 100);
    telemetry.observe(undefined, 1, 4_999, () => pressure);
    expect(emit).not.toHaveBeenCalled();
    telemetry.observe(undefined, 2, 5_000, () => pressure);
    telemetry.observe(undefined, 0, 5_001, () => pressure);
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledExactlyOnceWith({
        event: 'openkit.control_store.pressure',
        scope: 'workspace',
        'openkit.workspace.id': 'ws_00000000-0000-7000-8000-000000000001',
        ...pressure,
        databaseBytes: statSync(path).size,
        checkpointDue: true,
        walPressure: false,
        commitP99Ms: 128,
        commitSamples: 128,
        bodyGrowthBytes: 52,
        cutoffResponses: 3,
        windowMs: 5_000,
      })
    );
    // Admission can reach the pressure threshold with no new successful COMMIT.
    telemetry.observe(undefined, 0, 10_000, () => ({
      ...pressure,
      walBytes: CONTROL_STORE_BUDGET.maxWalBytes,
    }));
    await vi.waitFor(() =>
      expect(emit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          walPressure: true,
          commitP99Ms: null,
          commitSamples: 0,
          bodyGrowthBytes: 0,
          cutoffResponses: 0,
        })
      )
    );
  } finally {
    sibling.close();
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('continues committing when a diagnostic sink fails at its sampling deadline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-pressure-sink-'));
  const path = join(root, 'core.sqlite');
  const sqlite = new Database(path);
  try {
    const owner = controlStoreFor(sqlite);
    owner.write((db) => db.exec('CREATE TABLE witness (value INTEGER)'));
    const emit = vi.fn(() => {
      throw new Error('sink unavailable');
    });
    const telemetry = new ControlStorePressureTelemetry(sqlite, path, { scope: 'core' }, emit);
    telemetry.observe(owner.lastCommitMs, 0, 0, () => pressure);
    telemetry.observe(owner.lastCommitMs, 0, 5_000, () => pressure);
    expect(owner.write((db) => db.prepare('INSERT INTO witness VALUES (1)').run()).changes).toBe(1);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());
    expect(owner.write((db) => db.prepare('INSERT INTO witness VALUES (2)').run()).changes).toBe(1);
    expect(sqlite.prepare('SELECT value FROM witness ORDER BY value').all()).toEqual([
      { value: 1 },
      { value: 2 },
    ]);
  } finally {
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});
