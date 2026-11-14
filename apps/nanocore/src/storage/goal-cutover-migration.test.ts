import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';

describe('fresh Goal baseline', () => {
  it('contains only the accepted current Goal shapes', () => {
    const db = openWorkspaceDb(
      mkdtempSync(join(tmpdir(), 'goal-migration-')),
      'ws_00000000-0000-7509-8702-098e8909b075'
    );
    try {
      applyScopedMigrations(db);
      const names = (
        db.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      for (const name of [
        'goal_records',
        'goal_plan_records',
        'goal_tasks',
        'goal_review_records',
        'goal_verification_records',
        'pending_user_turn_records',
        'steering_terminal_outcomes',
      ])
        expect(names).not.toContain(name);
      for (const name of [
        'goals',
        'goal_cards',
        'goal_plan_versions',
        'goal_card_tasks',
        'task_turn_terminal_facts',
      ])
        expect(names).toContain(name);
      expect(names).toContain('pending_requests');
      expect(names).toContain('worker_turn_checkpoints');
    } finally {
      db.sqlite.close();
    }
  });
});
