import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMMUNICATION_TABLES,
  evaluateLookups,
  evaluatePartition,
  KERNEL_TABLES,
  LOOKUP_NO_HITS,
  NANOHOST_TABLES,
  OWNERS,
  RETIRED_TABLES,
  SECURITY_TRIGGER_TABLES,
  SERVER_WORK_TABLES,
  supportTableName,
} from './lib/storage-fitness-oracles.mjs';

const partitionScript = fileURLToPath(
  new URL('./storage-table-partition-oracle.mjs', import.meta.url)
);
const lookupScript = fileURLToPath(new URL('./storage-removed-lookup-oracle.mjs', import.meta.url));

const JOURNAL = Object.fromEntries(OWNERS.map((owner) => [owner.id, owner.journal]));

function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), 'storage-fitness-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeJournal(root, relativeDir, tables, extra = '') {
  const directory = join(root, relativeDir);
  mkdirSync(join(directory, 'meta'), { recursive: true });
  const sql = `${tables
    .map((table) => `CREATE TABLE \`${table}\` (\`id\` text);\n--> statement-breakpoint\n`)
    .join('')}${extra}`;
  writeFileSync(join(directory, '0000_baseline.sql'), sql);
  writeFileSync(
    join(directory, 'meta/_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: [{ idx: 0, version: '6', when: 1, tag: '0000_baseline', breakpoints: true }],
    })
  );
}

function writeSignedJournals(root, overrides = {}) {
  for (const owner of OWNERS) {
    writeJournal(
      root,
      owner.journal,
      overrides[owner.id] ?? owner.tables,
      overrides[`${owner.id}Sql`] ?? ''
    );
  }
}

function writeSource(root, relativePath, text) {
  const absolute = join(root, 'apps/nanocore/src', relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

test('signed partition names the 56 live tables and 2 retired tables', () => {
  const live = [
    ...KERNEL_TABLES,
    ...SERVER_WORK_TABLES,
    ...COMMUNICATION_TABLES,
    ...SECURITY_TRIGGER_TABLES,
    ...NANOHOST_TABLES,
  ];
  assert.equal(KERNEL_TABLES.length, 24);
  assert.equal(SERVER_WORK_TABLES.length, 7);
  assert.equal(COMMUNICATION_TABLES.length, 5);
  assert.equal(SECURITY_TRIGGER_TABLES.length, 6);
  assert.equal(NANOHOST_TABLES.length, 14);
  assert.equal(RETIRED_TABLES.length, 2);
  assert.equal(new Set([...live, ...RETIRED_TABLES]).size, 58);
});

test('partition oracle passes a signed fixture and fails a misplaced table', () => {
  withRoot((root) => {
    writeSignedJournals(root);
    const clean = evaluatePartition(root);
    assert.equal(clean.verdict, 'PASS');
    assert.equal(
      clean.owners.every((owner) => owner.verdict === 'PASS'),
      true
    );

    writeSignedJournals(root, {
      kernel: [...KERNEL_TABLES, 'control_threads'],
      'server-work': SERVER_WORK_TABLES.filter((table) => table !== 'control_threads'),
      kernelSql:
        "--> statement-breakpoint\nCREATE INDEX command_log_discord_event_idx ON `idempotency_requests` (`id`) WHERE command_name = 'channel.discord.inbound';\n",
    });
    const failed = evaluatePartition(root);
    assert.equal(failed.verdict, 'FAIL');
    const kernel = failed.owners.find((owner) => owner.id === 'kernel');
    const server = failed.owners.find((owner) => owner.id === 'server-work');
    assert.deepEqual(kernel.misplaced, [
      { table: 'control_threads', owner: 'server-work', note: '' },
    ]);
    assert.deepEqual(server.missing, ['control_threads']);
    assert.equal(
      kernel.predicates.some((item) => item.id === 'discord-inbound-command'),
      true
    );
    assert.equal(
      kernel.predicates.some((item) => item.id === 'discord-event-index'),
      true
    );

    const ran = spawnSync(process.execPath, [partitionScript, '--root', root], {
      encoding: 'utf8',
    });
    assert.equal(ran.status, 0);
    assert.match(ran.stdout, /table-partition-oracle: FAIL/);
    assert.match(ran.stdout, /control_threads -> server-work/);
  });
});

test('lookup oracle reports a cross-owner lookup and a retired table', () => {
  withRoot((root) => {
    writeJournal(root, 'apps/nanocore/drizzle/workspace', ['control_threads']);
    writeSource(
      root,
      'storage/core-journal-native.ts',
      [
        '// SELECT id FROM boot_audit_events',
        'export function read(db) {',
        "  return db.prepare('SELECT id FROM channel_account_bindings');",
        '}',
        'export function threads(db) {',
        "  return db.prepare('SELECT id FROM control_threads');",
        '}',
        '',
      ].join('\n')
    );
    writeSource(
      root,
      'channels/bindings.ts',
      "export function read(db) {\n  return db.prepare('SELECT id FROM channel_account_bindings');\n}\n"
    );
    writeSource(
      root,
      'auth/user-lifecycle.ts',
      "export function read(coreDb) {\n  return coreDb.prepare('SELECT id FROM users');\n}\n"
    );
    writeSource(
      root,
      'lib/store.ts',
      "export function boot(productDb) {\n  return productDb.prepare('SELECT id FROM control_threads');\n}\n"
    );
    writeSource(
      root,
      'storage/vault-native.ts',
      "export function write(db) {\n  return db.prepare('INSERT INTO boot_audit_events (id) VALUES (1)');\n}\n"
    );
    writeSource(
      root,
      'security/trigger.ts',
      "export function off(db) {\n  return db.prepare('SELECT id FROM notification_attention');\n}\n"
    );
    writeSource(
      root,
      'index.ts',
      "export function main(db) {\n  db.prepare('SELECT id FROM nanohost_runtime_targets');\n}\n"
    );
    writeSource(
      root,
      'llm/provider-subscription-accounts.ts',
      "export const action = 'provider_subscription.account.delete';\n"
    );
    writeSource(
      root,
      'channels/discord-command.ts',
      "export const description = 'One-use challenge from your OpenKit account settings.';\n"
    );
    writeSource(
      root,
      'runtime/task-steer-receipt.ts',
      "export function row(db) {\n  return db.prepare('SELECT b.agent_session_id AS session FROM agent_session_runtime_bindings b');\n}\n"
    );
    writeSource(
      root,
      'storage/schema/boot-audit-events.ts',
      "export const bootAuditEvents = sqliteTable(\n  'boot_audit_events',\n  {}\n);\n"
    );

    const report = evaluateLookups(root);
    assert.equal(report.verdict, 'FAIL');
    assert.equal(
      report.hits.some(
        (hit) =>
          hit.file.endsWith('storage/core-journal-native.ts') &&
          hit.table === 'channel_account_bindings' &&
          hit.owner === 'communication'
      ),
      true
    );
    assert.equal(
      report.hits.some((hit) => hit.table === 'control_threads' && hit.owner === 'server-work'),
      true
    );
    assert.equal(
      report.hits.some((hit) => hit.table === 'boot_audit_events' && hit.owner === 'removed'),
      true
    );
    assert.equal(
      report.hits.some(
        (hit) => hit.file.endsWith('security/trigger.ts') && hit.owner === 'communication'
      ),
      true
    );
    assert.equal(
      report.hits.some((hit) => hit.file.endsWith('/index.ts') && hit.owner === 'nanohost'),
      true
    );
    assert.equal(
      report.hits.some((hit) => hit.file.endsWith('channels/bindings.ts')),
      false
    );
    assert.equal(
      report.hits.some((hit) => hit.file.endsWith('auth/user-lifecycle.ts')),
      false
    );
    assert.equal(
      report.hits.some((hit) => hit.file.endsWith('lib/store.ts')),
      false
    );
    assert.equal(
      report.hits.some((hit) => hit.table === 'account'),
      false
    );
    assert.equal(
      report.hits.some(
        (hit) => hit.file.endsWith('runtime/task-steer-receipt.ts') && hit.table === 'session'
      ),
      false
    );
    assert.equal(
      report.hits.some(
        (hit) =>
          hit.file.endsWith('runtime/task-steer-receipt.ts') &&
          hit.table === 'agent_session_runtime_bindings' &&
          hit.owner === 'nanohost'
      ),
      true
    );
    assert.equal(
      report.hits.some(
        (hit) => hit.file.endsWith('storage/core-journal-native.ts') && hit.line === 1
      ),
      false
    );

    const ran = spawnSync(process.execPath, [lookupScript, '--root', root], { encoding: 'utf8' });
    assert.equal(ran.status, 0);
    assert.match(ran.stdout, /removed-lookup-oracle: FAIL/);
    assert.equal(ran.stdout.includes('PASS'), false);
    assert.match(ran.stdout, /violates communication table channel_account_bindings/);
    assert.match(ran.stdout, /REMOVED table boot_audit_events/);
  });
});

test('partition oracle uses canonical journals and one supporting table', () => {
  assert.equal(JOURNAL['server-work'], 'apps/nanocore/drizzle/services/server-work');
  assert.equal(JOURNAL.communication, 'apps/nanocore/drizzle/services/communication');
  assert.equal(JOURNAL['security-trigger'], 'apps/nanocore/drizzle/services/security-trigger');
  assert.equal(JOURNAL.nanohost, 'apps/nanocore/drizzle/extensions/nanohost');
  assert.equal(JOURNAL['openai-agents'], 'apps/nanocore/drizzle/extensions/openai-agents');
  assert.equal(JOURNAL.discord, 'apps/nanocore/drizzle/extensions/discord');
  assert.equal(supportTableName('server-work'), 'server_work_intents');

  withRoot((root) => {
    writeSignedJournals(root, {
      'server-work': [...SERVER_WORK_TABLES, 'server_work_intents'],
    });
    const supported = evaluatePartition(root);
    assert.equal(supported.verdict, 'PASS');
    const server = supported.owners.find((owner) => owner.id === 'server-work');
    assert.equal(server.supporting, 'server_work_intents');
    assert.equal(server.expectedMoved, 7);
    const rendered = spawnSync(process.execPath, [partitionScript, '--root', root], {
      encoding: 'utf8',
    });
    assert.match(rendered.stdout, /7 moved \+ 1 supporting/);
    assert.match(rendered.stdout, /24 moved \+ 0 supporting/);

    rmSync(join(root, JOURNAL['server-work']), { recursive: true, force: true });
    writeJournal(root, 'apps/nanocore/drizzle/server-work', [
      ...SERVER_WORK_TABLES,
      'server_work_intents',
    ]);
    const flat = evaluatePartition(root);
    const flatServer = flat.owners.find((owner) => owner.id === 'server-work');
    assert.equal(flat.verdict, 'FAIL');
    assert.equal(flatServer.journalState, 'missing');
    assert.equal(flatServer.journal, JOURNAL['server-work']);

    writeSignedJournals(root, {
      'server-work': [...SERVER_WORK_TABLES, 'server_work_intents', 'server_work_receipts'],
    });
    const second = evaluatePartition(root).owners.find((owner) => owner.id === 'server-work');
    assert.equal(second.verdict, 'FAIL');
    assert.equal(second.supporting, 'server_work_intents');
    assert.equal(second.extra.includes('server_work_receipts'), true);

    writeSignedJournals(root, {
      'server-work': [...SERVER_WORK_TABLES, 'server_work_intent'],
    });
    const misnamed = evaluatePartition(root).owners.find((owner) => owner.id === 'server-work');
    assert.equal(misnamed.verdict, 'FAIL');
    assert.equal(misnamed.supporting, null);
    assert.equal(misnamed.extra.includes('server_work_intent'), true);

    writeSignedJournals(root, {
      communication: [...COMMUNICATION_TABLES, 'server_work_intents'],
    });
    const wrongJournal = evaluatePartition(root).owners.find(
      (owner) => owner.id === 'communication'
    );
    assert.equal(wrongJournal.extra.includes('server_work_intents'), true);
    assert.equal(
      wrongJournal.misplaced.some(
        (item) => item.table === 'server_work_intents' && item.owner === 'server-work'
      ),
      true
    );

    writeSignedJournals(root, {
      kernel: [...KERNEL_TABLES, 'server_work_intents'],
    });
    const kernel = evaluatePartition(root).owners.find((owner) => owner.id === 'kernel');
    assert.equal(kernel.verdict, 'FAIL');
    assert.equal(kernel.supporting, null);
    assert.equal(kernel.expectedMoved, 24);
    assert.equal(kernel.extra.includes('server_work_intents'), true);
  });
});

test('partition oracle rejects vendor tokens and a sqlite_ lookalike table', () => {
  withRoot((root) => {
    writeSignedJournals(root, {
      kernelSql: [
        'ALTER TABLE `audit_events` ADD COLUMN discord_guild_id TEXT;',
        '--> statement-breakpoint',
        "CREATE INDEX audit_discord_idx ON `audit_events` (`id`) WHERE id LIKE 'discord:%';",
        '--> statement-breakpoint',
        'CREATE TABLE `sqliteBusiness` (`id` text);',
        '',
      ].join('\n'),
    });
    const kernel = evaluatePartition(root).owners.find((owner) => owner.id === 'kernel');
    assert.equal(kernel.extra.includes('sqliteBusiness'), true);
    assert.equal(
      kernel.predicates.some((item) => item.id.includes('discord_guild_id')),
      true
    );
    assert.equal(
      kernel.predicates.some((item) => item.id.includes('audit_discord_idx')),
      true
    );
    assert.equal(kernel.verdict, 'FAIL');
  });
});

test('lookup oracle reports removed names, typed receivers, and incomplete roots', () => {
  withRoot((root) => {
    const missing = evaluateLookups(root);
    assert.equal(missing.verdict, 'INCOMPLETE');
    const missingRun = spawnSync(process.execPath, [lookupScript, '--root', root], {
      encoding: 'utf8',
    });
    assert.equal(missingRun.status, 0);
    assert.match(missingRun.stdout, /removed-lookup-oracle: INCOMPLETE/);
    assert.equal(missingRun.stdout.includes('PASS'), false);

    mkdirSync(join(root, 'apps/nanocore/src'), { recursive: true });
    assert.equal(evaluateLookups(root).verdict, 'INCOMPLETE');

    writeSource(
      root,
      'channels/bindings.ts',
      "export function read(db) {\n  return db.prepare('SELECT id FROM channel_account_bindings');\n}\n"
    );
    const clean = evaluateLookups(root);
    assert.equal(clean.verdict, LOOKUP_NO_HITS);
    const cleanRun = spawnSync(process.execPath, [lookupScript, '--root', root], {
      encoding: 'utf8',
    });
    assert.match(
      cleanRun.stdout,
      /NO-HITS \(heuristic, not a reachability proof; A10 runtime test is the gate\)/
    );
    assert.equal(cleanRun.stdout.includes('PASS'), false);

    writeJournal(root, 'apps/nanocore/drizzle/workspace', ['control_threads']);
    writeSource(
      root,
      'channels/legacy-bindings.ts',
      "export function read(db) {\n  return db.prepare('SELECT id FROM discord_account_bindings');\n}\n"
    );
    writeSource(
      root,
      'runtime/nanohost-records.ts',
      "export function read(db: CoreDb) {\n  return db.prepare('SELECT id FROM sandbox_runtime_records');\n}\n"
    );
    writeSource(
      root,
      'runtime/nanohost-local.ts',
      "export function read(db) {\n  return db.prepare('SELECT id FROM sandbox_runtime_records');\n}\n"
    );
    writeSource(
      root,
      'storage/core-journal-native.ts',
      "export function boot(db: CoreDb, workspaceDb: WorkspaceDb) {\n  return db.prepare('SELECT id FROM control_threads');\n}\n"
    );
    writeSource(
      root,
      'runtime/nanohost-drizzle.ts',
      [
        "export const sandboxRuntimeRecords = sqliteTable('sandbox_runtime_records', {});",
        'export function read(db: CoreDb) {',
        '  return db.select().from(sandboxRuntimeRecords);',
        '}',
        '',
      ].join('\n')
    );

    const report = evaluateLookups(root);
    assert.equal(report.verdict, 'FAIL');
    assert.equal(
      report.hits.some(
        (hit) => hit.table === 'discord_account_bindings' && hit.owner === 'removed'
      ),
      true
    );
    assert.equal(
      report.hits.some(
        (hit) =>
          hit.file.endsWith('runtime/nanohost-records.ts') &&
          hit.table === 'sandbox_runtime_records' &&
          hit.owner === 'nanohost'
      ),
      true
    );
    assert.equal(
      report.hits.some((hit) => hit.file.endsWith('runtime/nanohost-local.ts')),
      false
    );
    assert.equal(
      report.hits.some(
        (hit) =>
          hit.file.endsWith('storage/core-journal-native.ts') &&
          hit.table === 'control_threads' &&
          hit.owner === 'server-work'
      ),
      true
    );
    assert.equal(
      report.hits.some(
        (hit) => hit.file.endsWith('runtime/nanohost-drizzle.ts') && hit.owner === 'nanohost'
      ),
      true
    );
  });
});

test('lookup oracle follows sqlite receivers and same-function sql bindings', () => {
  withRoot((root) => {
    writeJournal(root, 'apps/nanocore/drizzle/workspace', ['control_threads']);
    writeSource(
      root,
      'runtime/nanohost-sqlite.ts',
      "export function read(coreDb: CoreDb) {\n  return coreDb.sqlite.prepare('SELECT id FROM sandbox_runtime_records');\n}\n"
    );
    writeSource(
      root,
      'storage/core-journal-native-startup.ts',
      [
        'export function f(db: CoreDb, workspaceDb: WorkspaceDb) {',
        "  const sql = 'SELECT id FROM control_threads';",
        '  return db.sqlite.prepare(sql).get();',
        '}',
        '',
      ].join('\n')
    );
    const report = evaluateLookups(root);
    assert.equal(report.verdict, 'FAIL');
    assert.equal(
      report.hits.some(
        (hit) =>
          hit.file.endsWith('runtime/nanohost-sqlite.ts') &&
          hit.table === 'sandbox_runtime_records' &&
          hit.owner === 'nanohost'
      ),
      true
    );
    assert.equal(
      report.hits.some(
        (hit) =>
          hit.file.endsWith('storage/core-journal-native-startup.ts') &&
          hit.table === 'control_threads' &&
          hit.owner === 'server-work'
      ),
      true
    );
  });
});

test('partition oracle rejects a product token in a kernel check', () => {
  withRoot((root) => {
    writeSignedJournals(root, {
      kernelSql:
        "ALTER TABLE `audit_events` ADD COLUMN routing_label TEXT CHECK (routing_label <> 'discord:guild');\n",
    });
    const kernel = evaluatePartition(root).owners.find((owner) => owner.id === 'kernel');
    assert.equal(kernel.applyErrors.length, 0);
    assert.deepEqual(kernel.missing, []);
    assert.deepEqual(kernel.extra, []);
    assert.equal(
      kernel.predicates.some(
        (item) => item.kind === 'check' && item.id === 'vendor-token audit_events'
      ),
      true
    );
    assert.equal(
      kernel.predicates.some((item) => item.id.includes('routing_label')),
      false
    );
    assert.equal(kernel.verdict, 'FAIL');
  });
});

test('partition oracle rejects a product key seeded into server_settings', () => {
  const shape = [
    'CREATE TABLE `server_settings` (',
    '  `key` text PRIMARY KEY NOT NULL,',
    '  `value` text NOT NULL,',
    '  `updated_at` text NOT NULL,',
    '  `schema_version` integer DEFAULT 1 NOT NULL',
    ');',
    '--> statement-breakpoint',
  ].join('\n');
  withRoot((root) => {
    writeSignedJournals(root, {
      kernel: KERNEL_TABLES.filter((table) => table !== 'server_settings'),
      kernelSql: `${shape}INSERT INTO \`server_settings\` (\`key\`, \`value\`, \`updated_at\`) VALUES ('site.name', 'openkit', '2026-01-01');\n`,
    });
    const benign = evaluatePartition(root).owners.find((owner) => owner.id === 'kernel');
    assert.equal(benign.applyErrors.length, 0);
    assert.equal(benign.verdict, 'PASS');

    writeSignedJournals(root, {
      kernel: KERNEL_TABLES.filter((table) => table !== 'server_settings'),
      kernelSql: `${shape}INSERT INTO \`server_settings\` (\`key\`, \`value\`, \`updated_at\`) VALUES ('discord.guild_id', '1', '2026-01-01');\n`,
    });
    const kernel = evaluatePartition(root).owners.find((owner) => owner.id === 'kernel');
    assert.equal(kernel.applyErrors.length, 0);
    assert.deepEqual(kernel.missing, []);
    assert.deepEqual(kernel.extra, []);
    assert.equal(
      kernel.predicates.some(
        (item) => item.kind === 'seed' && item.id === 'vendor-token server_settings.key'
      ),
      true
    );
    assert.equal(kernel.verdict, 'FAIL');
  });
});
