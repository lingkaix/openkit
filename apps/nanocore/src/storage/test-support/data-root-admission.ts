import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { expect } from 'vitest';
import { openCoreDb } from '../db.js';
import { coreDbPath } from '../fs-layout.js';
import { applyMigrations } from '../migrate.js';

/** v0.1.0 Core baseline ledger identity. The current journal still uses this timestamp. */
const V010_CORE_LEDGER_AT = 1794664200000;
const V010_CORE_BASELINE_HASH = 'b1a74eaf44c5d2a552c2c5af6389be73a8f338125fbd4244b4c139cd1e2408c4';

/**
 * Builds one current Core file in a disposable root and replaces only its baseline hash.
 *
 * @returns Closed SQLite bytes for a digest-only v0.1.0 ledger.
 */
export function retainedV010CoreBytes(): Buffer {
  const source = mkdtempSync(join(tmpdir(), 'openkit-admission-fixture-'));
  try {
    const coreDb = openCoreDb(source);
    try {
      applyMigrations(coreDb);
      expect(
        coreDb.sqlite.prepare('SELECT created_at FROM __drizzle_migrations').pluck().get()
      ).toBe(V010_CORE_LEDGER_AT);
      const updated = coreDb.sqlite
        .prepare('UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?')
        .run(V010_CORE_BASELINE_HASH, V010_CORE_LEDGER_AT);
      expect(updated.changes).toBe(1);
      coreDb.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      coreDb.sqlite.close();
    }
    return readFileSync(coreDbPath(source));
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}

/**
 * Lists every directory and file under a root, with file bytes, in stable order.
 *
 * @param root Data root to inventory.
 * @returns Relative entries. Directory bytes stay null.
 */
export function dataRootInventory(root: string): Array<{ path: string; bytes: string | null }> {
  const entries: Array<{ path: string; bytes: string | null }> = [];

  /**
   * Visits one directory.
   *
   * @param directory Directory to visit.
   */
  function visit(directory: string): void {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const rel = relative(root, path);
      if (statSync(path).isDirectory()) {
        entries.push({ path: rel, bytes: null });
        visit(path);
      } else {
        entries.push({ path: rel, bytes: readFileSync(path).toString('base64') });
      }
    }
  }

  visit(root);
  return entries;
}
