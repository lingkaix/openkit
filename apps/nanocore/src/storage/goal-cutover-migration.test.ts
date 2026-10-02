import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openWorkspaceDb } from './db.js';
import { applyGoalCutover, removeGoalSandboxPin } from './goal-cutover.js';
import { applyScopedMigrations } from './migrate.js';

describe('Goal one-way cutover', () => {
  it('removes the seven retired owners and establishes only the accepted Goal shapes', () => {
    const db = openWorkspaceDb(mkdtempSync(join(tmpdir(), 'goal-migration-')), 'ws_goal');
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
  it('drops populated legacy families and only their checkpoints while shared owners remain byte-identical', () => {
    const db = openWorkspaceDb(mkdtempSync(join(tmpdir(), 'goal-old-families-')), 'ws_goal');
    applyScopedMigrations(db);
    try {
      const old = [
        'goal_records',
        'goal_plan_records',
        'goal_tasks',
        'goal_review_records',
        'goal_verification_records',
        'pending_user_turn_records',
        'steering_terminal_outcomes',
      ];
      for (const table of old)
        db.sqlite.exec(
          `CREATE TABLE ${table}(id TEXT PRIMARY KEY,payload TEXT); INSERT INTO ${table} VALUES ('old','legacy bytes');`
        );
      db.sqlite
        .prepare(
          'INSERT INTO artifact_reviews (workspace_id,review_id,artifact_id,artifact_version,content_digest,created_at) VALUES (?,?,?,?,?,?)'
        )
        .run(
          'ws_goal',
          `arev_${'a'.repeat(24)}`,
          'artifact_kept',
          1,
          `sha256:${'b'.repeat(64)}`,
          '2026-10-03T00:00:00.000Z'
        );
      const insert = db.sqlite.prepare(
        'INSERT INTO worker_turn_checkpoints (checkpoint_id,workspace_id,thread_id,turn_id,goal_id,task_id,request_id,request_input_hash,stage,iteration,context_digest,replay_instruction,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      );
      insert.run(
        'ordinary',
        'ws_goal',
        'th_task',
        'tu_task',
        null,
        null,
        'req_task',
        'sha256:task',
        'prepare',
        0,
        'sha256:context',
        0,
        'at',
        'at'
      );
      insert.run(
        'old-goal',
        'ws_goal',
        'th_old',
        'tu_old',
        'old',
        'old-task',
        'req_old',
        'sha256:old',
        'prepare',
        0,
        'sha256:context',
        0,
        'at',
        'at'
      );
      const tables = (
        db.sqlite
          .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      )
        .map((row) => row.name)
        .filter((name) => !old.includes(name) && name !== 'worker_turn_checkpoints');
      const before = new Map(
        tables.map((name) => [
          name,
          JSON.stringify(db.sqlite.prepare(`SELECT * FROM ${name}`).all()),
        ])
      );
      applyGoalCutover(db.sqlite);
      applyGoalCutover(db.sqlite);
      for (const name of old)
        expect(
          db.sqlite.prepare('SELECT name FROM sqlite_schema WHERE name=?').get(name)
        ).toBeUndefined();
      for (const [name, bytes] of before)
        expect(JSON.stringify(db.sqlite.prepare(`SELECT * FROM ${name}`).all()), name).toBe(bytes);
      expect(db.sqlite.prepare('SELECT checkpoint_id FROM worker_turn_checkpoints').all()).toEqual([
        { checkpoint_id: 'ordinary' },
      ]);
    } finally {
      db.sqlite.close();
    }
  });
  it('preserves predecessor pending requests and their index across a rerunnable cutover', () => {
    const db = openWorkspaceDb(mkdtempSync(join(tmpdir(), 'goal-old-pending-')), 'ws_goal');
    applyScopedMigrations(db);
    try {
      // Main's predecessor shape has neither Coordinator requesters nor deciding actor context.
      db.sqlite.exec('DROP TABLE pending_requests;');
      db.sqlite.exec(`CREATE TABLE \`pending_requests\` (
  \`request_id\` text PRIMARY KEY NOT NULL,
  \`workspace_id\` text NOT NULL,
  \`thread_id\` text NOT NULL,
  \`raising_turn_id\` text NOT NULL,
  \`request_item_id\` text NOT NULL,
  \`kind\` text NOT NULL,
  \`requester_kind\` text NOT NULL,
  \`agent_id\` text,
  \`agent_session_id\` text,
  \`responsible_user_id\` text NOT NULL,
  \`state\` text NOT NULL,
  \`resolution\` text,
  \`deciding_actor_kind\` text,
  \`deciding_actor_id\` text,
  \`decided_at\` text,
  \`answer_map_json\` text,
  \`ending\` text,
  \`invalidating_event\` text,
  \`ending_actor_kind\` text,
  \`ending_actor_id\` text,
  \`ended_at\` text,
  \`server_id\` text,
  \`catalog_revision\` text,
  \`schema_snapshot_id\` text,
  \`tool_name\` text,
  \`canonical_arguments_json\` text,
  \`arguments_digest\` text,
  \`package_digest\` text,
  \`policy_decision_id\` text,
  \`authorization_context_json\` text,
  \`governed_intent_json\` text,
  \`questions_json\` text,
  \`approval_kind\` text,
  \`title\` text,
  \`description\` text,
  \`claim\` text NOT NULL,
  \`execution_call_id\` text,
  \`disposition\` text,
  \`disposition_reason\` text,
  \`held_result_json\` text,
  \`publication_turn_id\` text,
  \`invalidation_turn_id\` text,
  \`delivery\` text NOT NULL,
  \`delivery_turn_id\` text,
  \`delivery_cause\` text,
  \`created_at\` text NOT NULL,
  \`updated_at\` text NOT NULL,
  CONSTRAINT \`pending_requests_kind_check\` CHECK (\`kind\` IN ('approval', 'user-input')),
  CONSTRAINT \`pending_requests_requester_kind_check\` CHECK (\`requester_kind\` IN ('worker', 'assistant', 'person')),
  CONSTRAINT \`pending_requests_state_check\` CHECK (\`state\` IN ('pending', 'resolved', 'ended')),
  CONSTRAINT \`pending_requests_resolution_check\` CHECK (\`resolution\` IS NULL OR \`resolution\` IN ('granted', 'denied', 'answered')),
  CONSTRAINT \`pending_requests_deciding_actor_kind_check\` CHECK (\`deciding_actor_kind\` IS NULL OR \`deciding_actor_kind\` IN ('user', 'system')),
  CONSTRAINT \`pending_requests_ending_check\` CHECK (\`ending\` IS NULL OR \`ending\` IN ('withdrawn', 'invalidated')),
  CONSTRAINT \`pending_requests_ending_actor_kind_check\` CHECK (\`ending_actor_kind\` IS NULL OR \`ending_actor_kind\` IN ('user', 'system')),
  CONSTRAINT \`pending_requests_claim_check\` CHECK (\`claim\` IN ('unclaimed', 'claimed', 'finished')),
  CONSTRAINT \`pending_requests_disposition_check\` CHECK (\`disposition\` IS NULL OR \`disposition\` IN ('approved-executed', 'denied-not-executed', 'execution-error', 'outcome-unknown')),
  CONSTRAINT \`pending_requests_delivery_check\` CHECK (\`delivery\` IN ('undelivered', 'frozen', 'delivered', 'delivery-unknown', 'closed-out')),
  CONSTRAINT \`pending_requests_delivery_cause_check\` CHECK (\`delivery_cause\` IS NULL OR \`delivery_cause\` IN ('outcome', 'carried')),
  CONSTRAINT \`pending_requests_approval_kind_check\` CHECK (\`approval_kind\` IS NULL OR \`approval_kind\` IN ('permission', 'destructive-action'))
);`);
      db.sqlite.exec(
        'CREATE INDEX pending_requests_thread_state_idx ON pending_requests(workspace_id,thread_id,state); CREATE TABLE goal_records(id TEXT PRIMARY KEY);'
      );
      db.sqlite
        .prepare(
          'INSERT INTO pending_requests (request_id,workspace_id,thread_id,raising_turn_id,request_item_id,kind,requester_kind,agent_id,agent_session_id,responsible_user_id,state,questions_json,title,description,claim,delivery,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
        )
        .run(
          'pr_kept',
          'ws_goal',
          'th_task',
          'tu_task',
          'it_request',
          'user-input',
          'worker',
          'agent_demo',
          'as_demo',
          'user_local',
          'pending',
          '[{"id":"choice","header":"Direction","question":"Choose a direction","options":null,"isOther":true,"isSecret":false}]',
          'Retained question',
          'Retained description',
          'unclaimed',
          'undelivered',
          '2026-10-03T00:00:00.000Z',
          '2026-10-03T00:00:00.000Z'
        );
      const before = db.sqlite.prepare('SELECT * FROM pending_requests').get() as Record<
        string,
        unknown
      >;
      const checkpoint = db.sqlite.prepare(
        'INSERT INTO worker_turn_checkpoints (checkpoint_id,workspace_id,thread_id,turn_id,goal_id,request_id,request_input_hash,stage,iteration,context_digest,replay_instruction,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
      );
      checkpoint.run(
        'ordinary',
        'ws_goal',
        'th_task',
        'tu_task',
        null,
        'req_task',
        'sha256:task',
        'prepare',
        0,
        'sha256:context',
        0,
        'at',
        'at'
      );
      checkpoint.run(
        'old-goal',
        'ws_goal',
        'th_old',
        'tu_old',
        'old',
        'req_old',
        'sha256:old',
        'prepare',
        0,
        'sha256:context',
        0,
        'at',
        'at'
      );
      const ordinary = db.sqlite
        .prepare("SELECT * FROM worker_turn_checkpoints WHERE checkpoint_id='ordinary'")
        .get();
      applyGoalCutover(db.sqlite);
      expect(db.sqlite.prepare('SELECT * FROM pending_requests').get()).toEqual({
        ...before,
        deciding_actor_context_json: null,
      });
      expect(
        db.sqlite
          .prepare("SELECT * FROM worker_turn_checkpoints WHERE checkpoint_id='old-goal'")
          .get()
      ).toBeUndefined();
      expect(db.sqlite.prepare('SELECT * FROM worker_turn_checkpoints').all()).toEqual([ordinary]);
      expect(
        db.sqlite.prepare('PRAGMA index_info(pending_requests_thread_state_idx)').all()
      ).toMatchObject([{ name: 'workspace_id' }, { name: 'thread_id' }, { name: 'state' }]);
      expect(() =>
        db.sqlite
          .prepare(
            "UPDATE pending_requests SET requester_kind='coordinator', agent_session_id=NULL WHERE request_id='pr_kept'"
          )
          .run()
      ).not.toThrow();
      const rows = db.sqlite.prepare('SELECT * FROM pending_requests').all();
      const schema = db.sqlite.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
      const changes = db.sqlite.prepare('SELECT total_changes() AS changes').get();
      applyGoalCutover(db.sqlite);
      expect(db.sqlite.prepare('SELECT * FROM pending_requests').all()).toEqual(rows);
      expect(db.sqlite.prepare('SELECT * FROM worker_turn_checkpoints').all()).toEqual([ordinary]);
      expect(db.sqlite.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()).toEqual(schema);
      expect(db.sqlite.prepare('SELECT total_changes() AS changes').get()).toEqual(changes);
    } finally {
      db.sqlite.close();
    }
  });
  it('clears and drops only the Sandbox pin column', () => {
    const db = new Database(':memory:');
    try {
      db.exec(
        "CREATE TABLE sandbox_runtime_records (id TEXT PRIMARY KEY,pinned_goal_id TEXT,retained TEXT); INSERT INTO sandbox_runtime_records VALUES ('sandbox','old','retained bytes');"
      );
      removeGoalSandboxPin(db);
      expect(db.prepare('SELECT * FROM sandbox_runtime_records').all()).toEqual([
        { id: 'sandbox', retained: 'retained bytes' },
      ]);
      removeGoalSandboxPin(db);
    } finally {
      db.close();
    }
  });
});
