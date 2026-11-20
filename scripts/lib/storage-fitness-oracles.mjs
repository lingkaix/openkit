/**
 * Report-mode fitness oracles for the v0.2.0 storage partition.
 *
 * Source: storage design Appendix A, section 5, and Appendix E A10.
 * Both oracles print a verdict and do not change process exit status.
 * They are not part of check:repo. A10's exact-build runtime test is the gate.
 *
 * Journal paths: drizzle/core, drizzle/services/{server-work,communication,
 * security-trigger}, and drizzle/extensions/{nanohost,openai-agents,discord}.
 * Workspace SQL is not an owner journal. It only identifies shared table names.
 *
 * A same-function `receiver.sqlite.prepare` call, and a string bound in that
 * function and passed to the call, uses the receiver's CoreDb or WorkspaceDb
 * type. The scan does not resolve cross-file imports or re-export barrels.
 * A table that is reachable only through a barrel is invisible here.
 * Zero lookup hits are a heuristic, not a reachability proof.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Application tables that must remain in the kernel journal. */
export const KERNEL_TABLES = [
  'account',
  'audit_events',
  'control_execution_steps',
  'control_executions',
  'idempotency_requests',
  'openkit_access_tokens',
  'permission_decisions',
  'recurring_expired_ranges',
  'recurring_occurrences',
  'recurring_schedules',
  'scheduler_admission_entries',
  'scheduler_execution_attempts',
  'server_settings',
  'session',
  'users',
  'vault_grants',
  'vault_injection_plans',
  'vault_injection_receipts',
  'vault_references',
  'vault_use_records',
  'verification',
  'workspace_invitations',
  'workspace_members',
  'workspace_registry',
];

/** Server-work tables. Six of the seven names also exist in the workspace journal. */
export const SERVER_WORK_TABLES = [
  'capability_calls',
  'control_product_entries',
  'control_threads',
  'control_turns',
  'control_work_observations',
  'evidence_bundles',
  'usage_records',
];

/** Communication tables after the three channel_* renames. */
export const COMMUNICATION_TABLES = [
  'channel_account_bindings',
  'channel_disclosures',
  'channel_pairing_challenges',
  'notification_attention',
  'notification_delivery_attempts',
];

/** Names the communication journal must no longer create. */
export const COMMUNICATION_RENAMES = {
  discord_account_bindings: 'channel_account_bindings',
  discord_disclosures: 'channel_disclosures',
  discord_pairing_challenges: 'channel_pairing_challenges',
};

/** Security-trigger tables. */
export const SECURITY_TRIGGER_TABLES = [
  'security_thread_destinations',
  'security_trigger_alarms',
  'security_trigger_audit_assessments',
  'security_trigger_audit_progress',
  'security_trigger_outbox',
  'security_trigger_state',
];

/** NanoHost extension tables. */
export const NANOHOST_TABLES = [
  'agent_session_runtime_binding_image_digests',
  'agent_session_runtime_bindings',
  'harness_instance_records',
  'nanohost_integration_identities',
  'nanohost_runtime_targets',
  'nanohost_transport_tokens',
  'sandbox_runtime_records',
  'worker_backend_sessions',
  'worker_control_records',
  'worker_control_rejected_evidence',
  'worker_control_sequence_fingerprints',
  'worker_image_settlements',
  'worker_storage_bindings',
  'worker_storage_contributors',
];

/** Tables that must not remain in any owner journal or any reachable lookup. */
export const RETIRED_TABLES = ['boot_audit_events', 'vault_admin_audit_events'];

/** One allowed supporting table name for a destination owner. The kernel has none. */
export function supportTableName(ownerId) {
  return `${ownerId.replaceAll('-', '_')}_intents`;
}

/**
 * Signed owner journals. Paths are relative to the repository root.
 * openai-agents and discord are design peers of nanohost with zero moved tables.
 */
export const OWNERS = [
  { id: 'kernel', journal: 'apps/nanocore/drizzle/core', tables: KERNEL_TABLES, support: false },
  {
    id: 'server-work',
    journal: 'apps/nanocore/drizzle/services/server-work',
    tables: SERVER_WORK_TABLES,
    support: true,
  },
  {
    id: 'communication',
    journal: 'apps/nanocore/drizzle/services/communication',
    tables: COMMUNICATION_TABLES,
    support: true,
  },
  {
    id: 'security-trigger',
    journal: 'apps/nanocore/drizzle/services/security-trigger',
    tables: SECURITY_TRIGGER_TABLES,
    support: true,
  },
  {
    id: 'nanohost',
    journal: 'apps/nanocore/drizzle/extensions/nanohost',
    tables: NANOHOST_TABLES,
    support: true,
  },
  {
    id: 'openai-agents',
    journal: 'apps/nanocore/drizzle/extensions/openai-agents',
    tables: [],
    support: true,
  },
  {
    id: 'discord',
    journal: 'apps/nanocore/drizzle/extensions/discord',
    tables: [],
    support: true,
  },
];

/** Lookup verdict when the heuristic finds nothing. This is not a proof. */
export const LOOKUP_NO_HITS =
  'NO-HITS (heuristic, not a reachability proof; A10 runtime test is the gate)';

const WORKSPACE_JOURNAL = 'apps/nanocore/drizzle/workspace';
const SOURCE_ROOT = 'apps/nanocore/src';
const METADATA_TABLES = new Set(['__drizzle_migrations', 'drizzle_migrations']);
const CREATE_TABLE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([A-Za-z_][A-Za-z0-9_]*)[`"']?/giu;
const HANDLE = /\b(productDb|workspaceDb|openWorkspaceDb|WorkspaceDb|coreDb|openCoreDb|CoreDb)\b/gu;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', 'test-support']);

/**
 * Product-specific column, check, seed, and index predicates that must not remain
 * in kernel DDL. Appendix A names these at the current core baseline.
 */
const KERNEL_PREDICATES = [
  { id: 'discord-inbound-command', kind: 'check', source: /channel\.discord\.inbound/gu },
  { id: 'discord-event-index', kind: 'index', source: /command_log_discord_event_idx/gu },
  { id: 'harness-consume', kind: 'index', source: /core-harness-consume\/v1/gu },
  { id: 'idle-cleanup', kind: 'index', source: /core-idle-cleanup\/v1/gu },
  {
    id: 'gateway-column',
    kind: 'column',
    source: /(?<![A-Za-z0-9_])(?:gateway_name|gateway_endpoint|cell_target_id)(?![A-Za-z0-9_])/gu,
  },
  { id: 'llm-api-literal', kind: 'check', source: /llm\.(?:chat_completions|responses)/gu },
  {
    id: 'security-rule-id',
    kind: 'check',
    source: /'(?:R1d|E12|R8)'|`rule` IN \('R1'/gu,
  },
  {
    id: 'product-seed',
    kind: 'seed',
    source:
      /INSERT\s+INTO\s+[`"']?(?:security_trigger_state|security_trigger_audit_progress|boot_audit_events|vault_admin_audit_events)\b/giu,
  },
];

/**
 * First match owns the file. NanoHost auth files precede the kernel auth tree.
 * Paths are relative to apps/nanocore/src. The scan does not skip startup,
 * offline, or disabled-owner modules.
 */
const FILE_OWNERS = [
  ['nanohost', 'auth/nanohost-'],
  ['nanohost', 'extensions/nanohost/'],
  ['nanohost', 'nanohost-listener.ts'],
  ['nanohost', 'runtime/nanohost-'],
  ['nanohost', 'runtime/worker-'],
  ['nanohost', 'storage/agent-session-runtime-binding'],
  ['nanohost', 'storage/nanohost-'],
  ['nanohost', 'storage/runtime-target-'],
  ['nanohost', 'storage/sandbox-runtime-'],
  ['nanohost', 'storage/schema/nanohost-'],
  ['nanohost', 'storage/schema/worker-backend-'],
  ['nanohost', 'storage/schema/worker-control-'],
  ['nanohost', 'storage/schema/worker-image-'],
  ['nanohost', 'storage/schema/worker-storage-'],
  ['nanohost', 'storage/worker-backend-session-'],
  ['nanohost', 'storage/worker-control-'],
  ['nanohost', 'storage/worker-image-'],
  ['nanohost', 'storage/worker-storage-binding-'],
  ['nanohost', 'worker-mcp-routes.ts'],
  ['communication', 'channels/'],
  ['communication', 'notifications/'],
  ['communication', 'channel-services.ts'],
  ['communication', 'discord-interaction-routes.ts'],
  ['communication', 'services/communication/'],
  ['communication', 'storage/communication-'],
  ['communication', 'storage/discord-'],
  ['security-trigger', 'security/'],
  ['security-trigger', 'services/security-trigger/'],
  ['security-trigger', 'storage/schema/security-'],
  ['security-trigger', 'storage/security-'],
  ['server-work', 'capability/'],
  ['server-work', 'evidence-bundles.ts'],
  ['server-work', 'internal-agents/'],
  ['server-work', 'llm/'],
  ['server-work', 'mode-entry-routes.ts'],
  ['server-work', 'server-thread-operations.ts'],
  ['server-work', 'services/server-work/'],
  ['server-work', 'storage/control-store-capability'],
  ['server-work', 'storage/control-store-knowledge'],
  ['server-work', 'storage/control-store-product'],
  ['server-work', 'storage/retained-server-work-'],
  ['server-work', 'storage/schema/capability-usage-ledger.ts'],
  ['server-work', 'storage/schema/evidence-bundles.ts'],
  ['server-work', 'storage/server-thread-'],
  ['server-work', 'storage/server-turn-'],
  ['server-work', 'storage/server-work-'],
  ['server-work', 'storage/work-observation'],
  ['workspace', 'lib/store.ts'],
  ['workspace', 'storage/schema/goals.ts'],
  ['workspace', 'storage/schema/work-product.ts'],
  ['workspace', 'storage/schema/workspace-'],
  ['kernel', 'auth/'],
  ['kernel', 'runtime/execution-attempt-records'],
  ['kernel', 'runtime/execution-attempts'],
  ['kernel', 'runtime/execution-journal'],
  ['kernel', 'runtime/execution-reconciler'],
  ['kernel', 'runtime/execution-step-journal'],
  ['kernel', 'runtime/scheduler-restart-recovery'],
  ['kernel', 'storage/command-request-'],
  ['kernel', 'storage/control-kernel-'],
  ['kernel', 'storage/control-store-admission'],
  ['kernel', 'storage/core-journal-native'],
  ['kernel', 'storage/execution-attempt-codec'],
  ['kernel', 'storage/schema/audit-events.ts'],
  ['kernel', 'storage/schema/better-auth/'],
  ['kernel', 'storage/schema/execution-journal.ts'],
  ['kernel', 'storage/schema/permission-decisions.ts'],
  ['kernel', 'storage/schema/scheduler-'],
  ['kernel', 'storage/schema/server-settings.ts'],
  ['kernel', 'storage/schema/vault-'],
  ['kernel', 'storage/schema/workspace-membership.ts'],
  ['kernel', 'storage/storage-owner.ts'],
  ['kernel', 'storage/vault-'],
];

const TABLE_OWNER = new Map();
for (const owner of OWNERS) {
  for (const table of owner.tables) TABLE_OWNER.set(table, owner.id);
  if (!owner.support) continue;
  const support = supportTableName(owner.id);
  if (TABLE_OWNER.has(support)) throw new Error(`Support table ${support} is already owned`);
  TABLE_OWNER.set(support, owner.id);
}
for (const table of RETIRED_TABLES) TABLE_OWNER.set(table, 'retired');
for (const [table, renamed] of Object.entries(COMMUNICATION_RENAMES)) {
  if (TABLE_OWNER.get(renamed) !== 'communication') {
    throw new Error(`Rename ${table} does not target a communication table`);
  }
  TABLE_OWNER.set(table, 'communication');
}

const REMOVED_NAMES = new Set([...RETIRED_TABLES, ...Object.keys(COMMUNICATION_RENAMES)]);
const VENDOR_TOKEN = /discord|guild/iu;

const LOOKUP_TABLES = [...TABLE_OWNER.keys()];

/** Returns the signed owner of one partition, rename, or retired table. */
export function tableOwner(table) {
  return TABLE_OWNER.get(table) ?? null;
}

/** Returns the owner of one source path relative to apps/nanocore/src. */
export function fileOwner(relativePath) {
  const path = relativePath.split('\\').join('/');
  for (const [owner, prefix] of FILE_OWNERS) {
    if (ownsPath(path, prefix)) return owner;
  }
  return 'unassigned';
}

/**
 * Applies every owner journal and compares application tables with Appendix A.
 * SQLite and Drizzle metadata tables are excluded.
 */
export function evaluatePartition(root) {
  const shared = workspaceTableNames(root);
  const owners = OWNERS.map((owner) => evaluateOwner(root, owner));
  const verdict = owners.every((owner) => owner.verdict === 'PASS') ? 'PASS' : 'FAIL';
  return { verdict, owners, sharedNames: [...shared].sort() };
}

/** Scans production source for SQL and DAL references outside the file owner. */
export function evaluateLookups(root) {
  const sourceRoot = join(root, SOURCE_ROOT);
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    return { verdict: 'INCOMPLETE', reason: 'scan root missing', hits: [] };
  }
  const files = sourceFiles(sourceRoot);
  if (files.length === 0) {
    return { verdict: 'INCOMPLETE', reason: 'scan root empty', hits: [] };
  }
  const shared = workspaceTableNames(root);
  const bindings = new Map();
  for (const file of files) {
    const text = readFileSync(join(sourceRoot, file), 'utf8');
    bindings.set(file, exportedTables(maskComments(text)));
  }
  const hits = [];
  for (const file of files) {
    const text = readFileSync(join(sourceRoot, file), 'utf8');
    const owner = fileOwner(file);
    collectSqlHits(hits, file, owner, text, shared);
    collectDefinitionHits(hits, file, owner, maskComments(text), shared);
    collectDrizzleReceiverHits(hits, file, text, shared);
    collectImportHits(hits, file, owner, text, bindings, sourceRoot, shared);
  }
  hits.sort((left, right) =>
    left.file === right.file
      ? left.line - right.line || left.table.localeCompare(right.table)
      : left.file.localeCompare(right.file)
  );
  const unique = [];
  const seen = new Set();
  for (const hit of hits) {
    const key = `${hit.file}:${hit.line}:${hit.table}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(hit);
  }
  return { verdict: unique.length === 0 ? LOOKUP_NO_HITS : 'FAIL', hits: unique };
}

/** Renders the partition report. The process still exits 0. */
export function formatPartition(report) {
  const lines = [`table-partition-oracle: ${report.verdict}`];
  for (const owner of report.owners) {
    lines.push(`${owner.id}: ${owner.verdict} journal=${owner.journalState} path=${owner.journal}`);
    lines.push(nameBlock('missing', owner.missing));
    lines.push(nameBlock('extra', owner.extra));
    lines.push(
      owner.misplaced.length === 0
        ? '  misplaced: none'
        : `  misplaced:\n${owner.misplaced
            .map((item) => `    ${item.table} -> ${item.owner}${item.note ? ` ${item.note}` : ''}`)
            .join('\n')}`
    );
    lines.push(`  count: ${owner.expectedMoved} moved + ${owner.supporting ? 1 : 0} supporting`);
    lines.push(owner.supporting ? `  supporting: ${owner.supporting}` : '  supporting: none');
    lines.push(nameBlock('retired', owner.retired));
    if (owner.id === 'kernel') {
      lines.push(
        owner.predicates.length === 0
          ? '  product-predicate: PASS'
          : `  product-predicate: FAIL\n${owner.predicates
              .map((item) => `    ${item.kind} ${item.id} ${item.file}:${item.line}`)
              .join('\n')}`
      );
    }
    for (const error of owner.applyErrors) {
      lines.push(`  apply-error: ${error.file}:${error.line} ${error.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Renders one lookup hit per line, then a count by violated owner. Never prints PASS. */
export function formatLookups(report) {
  const lines = [`removed-lookup-oracle: ${report.verdict}`];
  if (report.reason) lines.push(`reason: ${report.reason}`);
  lines.push(`hits: ${report.hits.length}`);
  for (const hit of report.hits) {
    lines.push(
      hit.owner === 'removed'
        ? `${hit.file}:${hit.line} REMOVED table ${hit.table}`
        : `${hit.file}:${hit.line} violates ${hit.owner} table ${hit.table}`
    );
  }
  const counts = new Map();
  for (const hit of report.hits) counts.set(hit.owner, (counts.get(hit.owner) ?? 0) + 1);
  const summary = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([owner, count]) => `${owner}=${count}`)
    .join(' ');
  lines.push(`by-owner: ${summary || 'none'}`);
  return `${lines.join('\n')}\n`;
}

function evaluateOwner(root, owner) {
  const loaded = loadJournal(root, owner.journal);
  const expected = new Set(owner.tables);
  const support = owner.support ? supportTableName(owner.id) : null;
  const base = {
    id: owner.id,
    journal: owner.journal,
    journalState: loaded.state,
    applyErrors: [],
    missing: [],
    extra: [],
    misplaced: [],
    retired: [],
    predicates: [],
    expectedMoved: owner.tables.length,
    supporting: null,
    verdict: 'FAIL',
  };
  if (loaded.state !== 'applied') {
    if (owner.tables.length === 0 && loaded.state === 'missing') {
      base.journalState = 'absent';
      base.verdict = 'PASS';
      return base;
    }
    base.missing = [...expected].sort();
    base.applyErrors = loaded.errors;
    return base;
  }
  const applied = applyJournal(loaded);
  base.applyErrors = applied.errors;
  const actual = new Set(applied.tables);
  base.supporting = support && actual.has(support) ? support : null;
  base.missing = [...expected].filter((table) => !actual.has(table)).sort();
  base.extra = [...actual]
    .filter((table) => !expected.has(table) && table !== base.supporting)
    .sort();
  base.retired = base.extra.filter((table) => RETIRED_TABLES.includes(table));
  base.misplaced = base.extra
    .map((table) => {
      const signed = tableOwner(table);
      if (!signed || signed === owner.id) return null;
      const note = COMMUNICATION_RENAMES[table]
        ? `(unrenamed ${COMMUNICATION_RENAMES[table]})`
        : '';
      return { table, owner: signed, note };
    })
    .filter((item) => item !== null);
  if (owner.id === 'kernel') {
    base.predicates = dedupePredicates([
      ...kernelPredicates(loaded.files),
      ...kernelVendorSchema(applied.schema, loaded.files),
    ]);
  }
  const failed =
    base.missing.length > 0 ||
    base.extra.length > 0 ||
    base.misplaced.length > 0 ||
    base.retired.length > 0 ||
    base.predicates.length > 0 ||
    base.applyErrors.length > 0;
  base.verdict = failed ? 'FAIL' : 'PASS';
  return base;
}

function loadJournal(root, journal) {
  const directory = join(root, journal);
  const metaPath = join(directory, 'meta/_journal.json');
  if (!existsSync(metaPath)) return { state: 'missing', files: [], errors: [] };
  let journalMeta;
  try {
    journalMeta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (error) {
    return {
      state: 'unreadable',
      files: [],
      errors: [{ file: relative(root, metaPath), line: 1, message: errorMessage(error) }],
    };
  }
  const entries = Array.isArray(journalMeta.entries) ? [...journalMeta.entries] : [];
  entries.sort((left, right) => left.idx - right.idx);
  const files = [];
  const errors = [];
  for (const entry of entries) {
    const absolute = join(directory, `${entry.tag}.sql`);
    const file = relative(root, absolute).split('\\').join('/');
    if (!existsSync(absolute)) {
      errors.push({ file, line: 1, message: 'journal SQL file is missing' });
      continue;
    }
    files.push({ file, sql: readFileSync(absolute, 'utf8') });
  }
  if (errors.length > 0) return { state: 'unreadable', files, errors };
  return { state: 'applied', files, errors: [] };
}

function applyJournal(loaded) {
  const db = new DatabaseSync(':memory:');
  const errors = [];
  try {
    for (const file of loaded.files) {
      for (const statement of statements(file.sql)) {
        if (statement.text.trim() === '') continue;
        try {
          db.exec(statement.text);
        } catch (error) {
          errors.push({ file: file.file, line: statement.line, message: errorMessage(error) });
        }
      }
    }
    return { tables: applicationTables(db), schema: readSchema(db), errors };
  } finally {
    db.close();
  }
}

function applicationTables(db) {
  return readSchema(db).tables.filter(
    (name) => name.startsWith('sqlite_') === false && !METADATA_TABLES.has(name)
  );
}

function readSchema(db) {
  const tableRows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
    )
    .all();
  const tables = tableRows
    .map((row) => row.name)
    .filter((name) => name.startsWith('sqlite_') === false);
  const columns = [];
  for (const table of tables) {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    for (const column of db.prepare(`PRAGMA table_info(${quoted})`).all()) {
      columns.push({ table, name: column.name });
    }
  }
  const indexes = db
    .prepare(
      "SELECT name, tbl_name AS tableName, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name"
    )
    .all();
  const definitions = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
    )
    .all()
    .filter((row) => row.name.startsWith('sqlite_') === false && !METADATA_TABLES.has(row.name));
  const seeds = [];
  for (const table of tables) {
    if (METADATA_TABLES.has(table)) continue;
    const quoted = `"${table.replaceAll('"', '""')}"`;
    for (const row of db.prepare(`SELECT * FROM ${quoted}`).all()) {
      for (const [column, value] of Object.entries(row)) {
        if (value == null || !VENDOR_TOKEN.test(String(value))) continue;
        seeds.push({ table, column, value: String(value) });
      }
    }
  }
  return { tables, columns, indexes, definitions, seeds };
}

function statements(sql) {
  const marker = /-->\s*statement-breakpoint\s*/gu;
  const chunks = [];
  let last = 0;
  for (const match of sql.matchAll(marker)) {
    chunks.push({ text: sql.slice(last, match.index), line: lineNumber(sql, last) });
    last = match.index + match[0].length;
  }
  chunks.push({ text: sql.slice(last), line: lineNumber(sql, last) });
  return chunks;
}

function kernelPredicates(files) {
  const hits = [];
  for (const file of files) {
    const masked = maskComments(file.sql);
    for (const predicate of KERNEL_PREDICATES) {
      const expression = new RegExp(predicate.source.source, predicate.source.flags);
      for (const match of masked.matchAll(expression)) {
        hits.push({
          kind: predicate.kind,
          id: predicate.id,
          file: file.file,
          line: lineNumber(file.sql, match.index),
        });
      }
    }
    const expression = new RegExp(CREATE_TABLE.source, CREATE_TABLE.flags);
    for (const match of masked.matchAll(expression)) {
      const table = match[1];
      if (KERNEL_TABLES.includes(table) || METADATA_TABLES.has(table)) continue;
      hits.push({
        kind: 'table',
        id: table,
        file: file.file,
        line: lineNumber(file.sql, match.index),
      });
    }
  }
  hits.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.id.localeCompare(right.id)
  );
  return dedupePredicates(hits);
}

function kernelVendorSchema(schema, files) {
  const hits = [];
  const place = (needle) =>
    locateSql(files, needle) ?? { file: files[0]?.file ?? 'kernel', line: 1 };
  for (const table of schema.tables) {
    if (!VENDOR_TOKEN.test(table) || METADATA_TABLES.has(table)) continue;
    const located = place(table);
    hits.push({
      kind: 'table',
      id: `vendor-token ${table}`,
      file: located.file,
      line: located.line,
    });
  }
  for (const column of schema.columns) {
    if (!VENDOR_TOKEN.test(column.name)) continue;
    const located = place(column.name);
    hits.push({
      kind: 'column',
      id: `vendor-token ${column.table}.${column.name}`,
      file: located.file,
      line: located.line,
    });
  }
  for (const index of schema.indexes) {
    const predicate = index.sql ?? '';
    if (!VENDOR_TOKEN.test(index.name) && !VENDOR_TOKEN.test(predicate)) continue;
    const located = locateSql(files, index.name) ?? place(predicate);
    hits.push({
      kind: 'index',
      id: `vendor-token ${index.name}`,
      file: located.file,
      line: located.line,
    });
  }
  for (const definition of schema.definitions ?? []) {
    const body = definition.sql ? definition.sql.split(definition.name).join('') : '';
    if (!VENDOR_TOKEN.test(body)) continue;
    const located = place(definition.name);
    hits.push({
      kind: 'check',
      id: `vendor-token ${definition.name}`,
      file: located.file,
      line: located.line,
    });
  }
  for (const seed of schema.seeds ?? []) {
    const located = locateSql(files, seed.value) ?? place(seed.table);
    hits.push({
      kind: 'seed',
      id: `vendor-token ${seed.table}.${seed.column}`,
      file: located.file,
      line: located.line,
    });
  }
  return hits;
}

function dedupePredicates(hits) {
  const sorted = [...hits].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id)
  );
  return sorted.filter((hit, index) => {
    const previous = sorted[index - 1];
    return (
      !previous ||
      previous.file !== hit.file ||
      previous.line !== hit.line ||
      previous.kind !== hit.kind ||
      previous.id !== hit.id
    );
  });
}

function locateSql(files, needle) {
  const source = String(needle ?? '');
  if (source === '') return null;
  const wanted = source.toLowerCase();
  for (const file of files) {
    const index = file.sql.toLowerCase().indexOf(wanted);
    if (index >= 0) return { file: file.file, line: lineNumber(file.sql, index) };
  }
  return null;
}

function workspaceTableNames(root) {
  const names = new Set();
  const directory = join(root, WORKSPACE_JOURNAL);
  if (!existsSync(directory)) return names;
  for (const file of walkFiles(directory).filter((path) => path.endsWith('.sql'))) {
    const sql = maskComments(readFileSync(file, 'utf8'));
    const expression = new RegExp(CREATE_TABLE.source, CREATE_TABLE.flags);
    for (const match of sql.matchAll(expression)) names.add(match[1]);
  }
  return names;
}

function sourceFiles(sourceRoot) {
  return walkFiles(sourceRoot)
    .filter((absolute) => {
      const name = absolute.slice(absolute.lastIndexOf('/') + 1);
      return SOURCE_FILE.test(name) && !TEST_FILE.test(name);
    })
    .map((absolute) => relative(sourceRoot, absolute).split('\\').join('/'))
    .sort();
}

function walkFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      files.push(...walkFiles(join(directory, entry.name)));
    } else if (entry.isFile()) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

function collectSqlHits(hits, file, owner, text, shared) {
  for (const piece of stringPieces(text)) {
    const receiver = directReceiver(text, piece.index);
    const effectiveOwner = receiver?.owner ?? owner;
    const scope = receiver?.scope ?? scopeBefore(text, piece.index);
    for (const table of tablesInSql(piece.text)) {
      const violated = violatedOwner(effectiveOwner, table, scope, shared);
      if (!violated) continue;
      hits.push({
        file: `${SOURCE_ROOT}/${file}`,
        line: lineNumber(text, piece.index),
        owner: violated,
        table,
      });
    }
  }
}

function collectDrizzleReceiverHits(hits, file, text, shared) {
  const masked = maskComments(text);
  const locals = new Map();
  const declared =
    /(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*sqliteTable\(\s*(?:\/\*[\s\S]*?\*\/\s*)*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]/gu;
  for (const match of masked.matchAll(declared)) locals.set(match[1], match[2]);
  if (locals.size === 0) return;
  const calls =
    /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(?:insert|update|delete)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\b|([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*select\s*\(\s*\)\s*\.\s*from\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\b/gu;
  for (const match of masked.matchAll(calls)) {
    const receiverName = match[1] ?? match[3];
    const binding = match[2] ?? match[4];
    const table = locals.get(binding);
    if (!table) continue;
    const receiver = typedReceiver(masked, match.index, receiverName);
    if (!receiver) continue;
    const violated = violatedOwner(receiver.owner, table, receiver.scope, shared);
    if (!violated) continue;
    hits.push({
      file: `${SOURCE_ROOT}/${file}`,
      line: lineNumber(masked, match.index),
      owner: violated,
      table,
    });
  }
}

function collectDefinitionHits(hits, file, owner, masked, shared) {
  const expression = /sqliteTable\(\s*(?:\/\*[\s\S]*?\*\/\s*)*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]/gu;
  for (const match of masked.matchAll(expression)) {
    const table = match[1];
    const violated = violatedOwner(owner, table, 'unknown', shared);
    if (!violated) continue;
    hits.push({
      file: `${SOURCE_ROOT}/${file}`,
      line: lineNumber(masked, match.index),
      owner: violated,
      table,
    });
  }
}

function collectImportHits(hits, file, owner, text, bindings, sourceRoot, shared) {
  const masked = maskComments(text);
  const patterns = [
    /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gu,
    /export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gu,
    /export\s+\*\s+from\s+['"]([^'"]+)['"]/gu,
  ];
  for (const pattern of patterns) {
    for (const match of masked.matchAll(pattern)) {
      if (
        pattern === patterns[0] &&
        masked.slice(match.index, match.index + 12) === 'import type '
      ) {
        continue;
      }
      const specifier = match[pattern === patterns[2] ? 1 : 2];
      if (!specifier.startsWith('.')) continue;
      const target = resolveSource(sourceRoot, file, specifier);
      if (!target) continue;
      const imported = match[1] && pattern !== patterns[2] ? bindingNames(match[1]) : null;
      const tables = bindings.get(target) ?? new Map();
      const selected = imported
        ? [...imported.entries()].filter(([exported]) => tables.has(exported))
        : [...tables.entries()].map(([exported]) => [exported, exported]);
      for (const [exported, local] of selected) {
        const table = tables.get(exported);
        if (!table) continue;
        const mention = imported
          ? pattern === patterns[0]
            ? new RegExp(`\\.(?:from|insert|update|delete)\\(\\s*${local}\\b`, 'u').test(masked)
            : true
          : true;
        if (!mention) continue;
        const violated = violatedOwner(owner, table, 'unknown', shared);
        if (!violated) continue;
        hits.push({
          file: `${SOURCE_ROOT}/${file}`,
          line: lineNumber(masked, match.index),
          owner: violated,
          table,
        });
      }
    }
  }
}

function exportedTables(masked) {
  const tables = new Map();
  const expression =
    /export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*sqliteTable\(\s*(?:\/\*[\s\S]*?\*\/\s*)*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]/gu;
  for (const match of masked.matchAll(expression)) tables.set(match[1], match[2]);
  return tables;
}

function bindingNames(clause) {
  const names = new Map();
  for (const part of clause.split(',')) {
    const tokens = part
      .trim()
      .split(/\s+/u)
      .filter((token) => token !== 'type');
    if (tokens.length === 0) continue;
    if (tokens.length >= 3 && tokens[1] === 'as') names.set(tokens[0], tokens[2]);
    else names.set(tokens[0], tokens[0]);
  }
  return names;
}

function resolveSource(sourceRoot, fromFile, specifier) {
  const base = join(sourceRoot, fromFile, '..', specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`];
  if (!SOURCE_FILE.test(base)) {
    candidates.push(join(base, 'index.ts'), join(base, 'index.js'));
  }
  for (const candidate of candidates) {
    const normalized = candidate.replace(/\.js$/u, '.ts');
    if (existsSync(normalized) && statSync(normalized).isFile()) {
      return relative(sourceRoot, normalized).split('\\').join('/');
    }
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(sourceRoot, candidate).split('\\').join('/');
    }
  }
  return null;
}

function violatedOwner(owner, table, scope, shared) {
  if (REMOVED_NAMES.has(table)) return 'removed';
  const signed = tableOwner(table);
  if (!signed) return null;
  if (signed === 'retired') return 'removed';
  if (owner === signed) return null;
  if (shared.has(table) && (scope === 'workspace' || owner === 'workspace')) return null;
  return signed;
}

function directReceiver(source, index) {
  const before = source.slice(Math.max(0, index - 180), index);
  const call = before.match(
    /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.\s*sqlite\s*)?\.\s*(?:prepare|exec|get|all|run|select|insert|update|delete)\s*\(\s*['"`]\s*$/u
  );
  if (call) {
    const typed = typedReceiver(source, index, call[1]);
    if (typed) return typed;
    if (sqliteMemberBefore(before)) return { owner: null, scope: 'unknown' };
    return null;
  }
  const bound = boundReceiverName(source, index);
  if (!bound) return null;
  return typedReceiver(source, index, bound) ?? { owner: null, scope: 'unknown' };
}

function sqliteMemberBefore(before) {
  return /\.\s*sqlite\s*\.\s*(?:prepare|exec|get|all|run|select|insert|update|delete)\s*\(\s*['"`]\s*$/u.test(
    before
  );
}

function boundReceiverName(source, index) {
  const before = source.slice(Math.max(0, index - 240), index);
  const binding = before.match(/(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"`]\s*$/u);
  if (!binding) return null;
  const name = binding[1];
  const body = source.slice(index, functionEnd(source, functionStart(source, index)));
  const use = new RegExp(
    `([A-Za-z_][A-Za-z0-9_]*)\\s*(?:\\.\\s*sqlite\\s*)?\\.\\s*(?:prepare|exec|get|all|run|select|insert|update|delete)\\s*\\(\\s*${name}\\b`,
    'u'
  );
  const match = use.exec(body);
  return match ? match[1] : null;
}

function typedReceiver(source, index, name) {
  const header = source.slice(functionStart(source, index), index);
  const typed = new RegExp(`\\b${name}\\s*:\\s*(CoreDb|WorkspaceDb)\\b`, 'u');
  const match = typed.exec(header);
  if (!match) return null;
  if (match[1] === 'CoreDb') return { owner: 'kernel', scope: 'core' };
  return { owner: 'workspace', scope: 'workspace' };
}

function functionStart(source, index) {
  const before = source.slice(0, index);
  let last = 0;
  for (const match of before.matchAll(/\bfunction\b/gu)) last = match.index;
  const arrows =
    /(?:const|let|var)\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*)\s*=>/gu;
  for (const match of before.matchAll(arrows)) {
    if (match.index > last) last = match.index;
  }
  return last;
}

function functionEnd(source, start) {
  let depth = 0;
  let seen = false;
  let state = 'code';
  for (let index = start; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === 'line') {
      if (current === '\n') state = 'code';
      continue;
    }
    if (state === 'block') {
      if (current === '*' && next === '/') {
        state = 'code';
        index += 1;
      }
      continue;
    }
    if (state === "'" || state === '"' || state === '`') {
      if (current === '\\') {
        index += 1;
        continue;
      }
      if (current === state) state = 'code';
      continue;
    }
    if (current === '/' && next === '/') {
      state = 'line';
      index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      state = 'block';
      index += 1;
      continue;
    }
    if (current === "'" || current === '"' || current === '`') {
      state = current;
      continue;
    }
    if (current === '{') {
      depth += 1;
      seen = true;
    } else if (current === '}') {
      depth -= 1;
      if (seen && depth === 0) return index;
    }
  }
  return source.length;
}

const TABLE_NAME_PATTERN = [...LOOKUP_TABLES]
  .sort((left, right) => right.length - left.length)
  .join('|');

/** A table is an SQL reference only when it is the object of a clause, not an alias or prose. */
function tablesInSql(text) {
  const found = new Set();
  const expression = new RegExp(
    `\\b(?:from|join|into|update|table|references)\\s+[\`"]?(${TABLE_NAME_PATTERN})[\`"]?(?![A-Za-z0-9_])`,
    'giu'
  );
  for (const match of text.matchAll(expression)) found.add(match[1].toLowerCase());
  return [...found];
}

function scopeBefore(source, index) {
  const before = source.slice(Math.max(0, index - 1200), index);
  let last = null;
  for (const match of before.matchAll(HANDLE)) last = match[1];
  if (!last) return 'unknown';
  if (last === 'productDb' || last.includes('orkspace') || last.includes('Workspace')) {
    return 'workspace';
  }
  return 'core';
}

function stringPieces(source) {
  const pieces = [];
  const length = source.length;
  let index = 0;
  let state = 'code';
  let pieceStart = 0;
  while (index < length) {
    const current = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (current === '/' && next === '/') {
        state = 'line';
        index += 2;
        continue;
      }
      if (current === '/' && next === '*') {
        state = 'block';
        index += 2;
        continue;
      }
      if (current === "'" || current === '"' || current === '`') {
        state = current;
        pieceStart = index + 1;
        index += 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (state === 'line') {
      if (current === '\n') state = 'code';
      index += 1;
      continue;
    }
    if (state === 'block') {
      if (current === '*' && next === '/') {
        state = 'code';
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (state === '`' && current === '$' && next === '{') {
      pieces.push({ index: pieceStart, text: source.slice(pieceStart, index) });
      index = skipTemplateExpression(source, index + 2);
      pieceStart = index;
      continue;
    }
    if (
      (state === "'" && current === "'" && !isEscaped(source, index)) ||
      (state === '"' && current === '"' && !isEscaped(source, index)) ||
      (state === '`' && current === '`' && !isEscaped(source, index))
    ) {
      pieces.push({ index: pieceStart, text: source.slice(pieceStart, index) });
      state = 'code';
      index += 1;
      continue;
    }
    index += 1;
  }
  return pieces;
}

function skipTemplateExpression(source, start) {
  let depth = 1;
  let state = 'code';
  for (let index = start; index < source.length; index += 1) {
    const current = source[index];
    if (state === 'code') {
      if (current === "'" || current === '"' || current === '`') {
        state = current;
        continue;
      }
      if (current === '{') depth += 1;
      if (current === '}') {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      continue;
    }
    if (
      (state === "'" || state === '"' || state === '`') &&
      current === state &&
      !isEscaped(source, index)
    ) {
      state = 'code';
    }
  }
  return source.length;
}

function maskComments(source) {
  const chars = source.split('');
  let state = 'code';
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index];
    const next = chars[index + 1];
    if (state === 'code') {
      if (current === '/' && next === '/') {
        state = 'line';
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 1;
        continue;
      }
      if (current === '/' && next === '*') {
        state = 'block';
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 1;
        continue;
      }
      if (current === "'" || current === '"' || current === '`') state = current;
      continue;
    }
    if (state === 'line') {
      if (current === '\n') state = 'code';
      else chars[index] = ' ';
      continue;
    }
    if (state === 'block') {
      if (current === '*' && next === '/') {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        state = 'code';
        index += 1;
        continue;
      }
      if (current !== '\n') chars[index] = ' ';
      continue;
    }
    if (current === state && !isEscaped(source, index)) state = 'code';
  }
  return chars.join('');
}

function isEscaped(source, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function ownsPath(path, prefix) {
  if (prefix.endsWith('/')) return path.startsWith(prefix);
  if (!prefix.includes('.')) return path.startsWith(prefix);
  return path === prefix;
}

function nameBlock(label, names) {
  if (names.length === 0) return `  ${label}: none`;
  return `  ${label}:\n${names.map((name) => `    ${name}`).join('\n')}`;
}

function lineNumber(text, index) {
  let line = 1;
  const end = Math.min(index, text.length);
  for (let cursor = 0; cursor < end; cursor += 1) if (text[cursor] === '\n') line += 1;
  return line;
}

function errorMessage(error) {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}
