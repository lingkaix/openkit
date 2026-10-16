import { ensureLocalUser as ensureRecordedLocalUser } from '../auth/identity.js';
import type { CoreDb } from '../storage/db.js';

/** Explicit canonical identity for fixtures that assert exact local-owner bytes. */
export const FIXTURE_LOCAL_USER_ID = 'usr_00000000-0000-7000-8000-000000000001';

/** Seeds fixture authority explicitly, then exercises the production recorded-User reader. */
export function ensureLocalUser(coreDb: CoreDb): string {
  const existing = coreDb.sqlite.prepare("SELECT id FROM users WHERE kind = 'local'").all();
  if (existing.length === 0) {
    const now = new Date().toISOString();
    coreDb.sqlite
      .prepare(`INSERT INTO users
      (id, kind, display_name, email, email_verified, created_at, updated_at, status)
      VALUES (?, 'local', 'Local fixture', ?, 0, ?, ?, 'active')`)
      .run(FIXTURE_LOCAL_USER_ID, ['fixture-local', 'example.invalid'].join('@'), now, now);
  }
  return ensureRecordedLocalUser(coreDb);
}
