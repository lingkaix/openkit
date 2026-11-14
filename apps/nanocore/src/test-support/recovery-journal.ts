import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

/** Independent read of the original Core journal and immutable proof, also injected into native observers. */
export function recoveryJournalFact(
  db: Database.Database,
  id: string,
  dataRoot: string,
  read = readFileSync,
  hash = createHash
) {
  const row = db
    .prepare(`SELECT e.*, s.control_json, s.invocation_json, s.span_json AS step_span
    FROM control_executions e JOIN control_execution_steps s ON s.execution_id=e.id
    WHERE e.definition_version='core-workspace-recovery/v1'
      AND json_extract(s.invocation_json,'$.carriage.requestId')=?
    ORDER BY json_extract(s.invocation_json,'$.carriage.sequence') DESC LIMIT 1`)
    .get(id) as
    | {
        phase: string;
        terminal_cause: string | null;
        work_id: string;
        control_json: string;
        invocation_json: string;
        span_json: string;
        step_span: string;
      }
    | undefined;
  if (!row) return undefined;
  const control = JSON.parse(row.control_json);
  const carriage = JSON.parse(row.invocation_json).carriage;
  const content = JSON.parse(control.inputRefs[0]);
  const digest = content.reference.contentDigest;
  if (
    !/^sha256:[a-f0-9]{64}$/.test(digest) ||
    content.reference.locator.mount !== 'backend-evidence' ||
    JSON.stringify(content.reference.locator.ownerScope) !== JSON.stringify({ kind: 'server' }) ||
    content.reference.locator.path !== `sha256/${digest.slice(7)}`
  )
    throw new Error('Recovery proof is not the original Core content binding.');
  const bytes = read(`${dataRoot}/server/evidence/backend/sha256/${digest.slice(7)}`);
  if (
    bytes.length !== content.byteLength ||
    `sha256:${hash('sha256').update(bytes).digest('hex')}` !== digest
  )
    throw new Error('Recovery proof bytes contradict the original journal descriptor.');
  const proof_json = bytes.toString('utf8');
  const proof = JSON.parse(proof_json);
  const revision = Number(control.authorityRefs[1]);
  const candidate = carriage.bindingRef;
  const expectedFingerprint = `sha256:${hash('sha256')
    .update(JSON.stringify({ candidate, id, proof: digest, revision }))
    .digest('hex')}`;
  if (
    control.fingerprint !== expectedFingerprint ||
    JSON.stringify(control.authorityRefs) !== JSON.stringify([id, String(revision)]) ||
    carriage.operation !== 'workspace.recovery' ||
    carriage.requestId !== id ||
    row.work_id !== proof.manifest.workspaceId
  )
    throw new Error(
      'Recovery journal identity, domain revision, candidate or proof binding changed.'
    );
  return {
    admission_id: id,
    backup_id: proof.manifest.backupId,
    workspace_id: row.work_id,
    purpose: proof.manifest.purpose,
    state:
      row.phase === 'open'
        ? 'prepared'
        : row.terminal_cause?.startsWith('abandoned:')
          ? 'abandoned'
          : 'finished',
    revision,
    candidate_ref: candidate,
    proof_json,
    updated_at: JSON.parse(row.step_span).startTimeUnixNano,
  };
}

/** Includes all original request identities; later linked roots do not duplicate admissions. */
export function recoveryJournalFacts(db: Database.Database, dataRoot: string) {
  const ids = db
    .prepare(`SELECT DISTINCT json_extract(s.invocation_json,'$.carriage.requestId') AS id
    FROM control_executions e JOIN control_execution_steps s ON s.execution_id=e.id
    WHERE e.definition_version='core-workspace-recovery/v1' ORDER BY id`)
    .all() as { id: string }[];
  return ids.map(({ id }) => recoveryJournalFact(db, id, dataRoot)!);
}

/** Controlled retained-content corruption/format fixture; never used to admit a valid recovery. */
export function replaceRecoveryJournalProof(
  db: Database.Database,
  id: string,
  dataRoot: string,
  proof: unknown
) {
  const row = db
    .prepare(`SELECT execution_id,step_id,control_json,invocation_json FROM control_execution_steps
    WHERE json_extract(control_json,'$.definitionVersion')='core-workspace-recovery/v1'
      AND json_extract(invocation_json,'$.carriage.requestId')=?
    ORDER BY json_extract(invocation_json,'$.carriage.sequence') DESC LIMIT 1`)
    .get(id) as {
    execution_id: string;
    step_id: string;
    control_json: string;
    invocation_json: string;
  };
  const control = JSON.parse(row.control_json);
  const content = JSON.parse(control.inputRefs[0]);
  const bytes = Buffer.from(JSON.stringify(proof));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const path = join(dataRoot, 'server/evidence/backend/sha256', digest);
  writeFileSync(path, bytes, { mode: 0o600 });
  const next = {
    ...content,
    byteLength: bytes.length,
    reference: {
      ...content.reference,
      contentDigest: `sha256:${digest}`,
      locator: { ...content.reference.locator, path: `sha256/${digest}` },
    },
  };
  const encoded = JSON.stringify(next);
  control.inputRefs = [encoded];
  if (control.outputRefs.length) control.outputRefs = [encoded];
  control.fingerprint = `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        candidate: JSON.parse(row.invocation_json).carriage.bindingRef,
        id,
        proof: `sha256:${digest}`,
        revision: Number(control.authorityRefs[1]),
      })
    )
    .digest('hex')}`;
  // Corrupt only this genuine retained specimen, with the original invariant restored
  // before any product call. Normal producers always run with this trigger present.
  return db.transaction(() => {
    const { sql } = db
      .prepare("SELECT sql FROM sqlite_schema WHERE name='control_execution_steps_settle_once'")
      .get() as { sql: string };
    db.exec('DROP TRIGGER control_execution_steps_settle_once');
    try {
      return db
        .prepare(
          'UPDATE control_execution_steps SET control_json=? WHERE execution_id=? AND step_id=?'
        )
        .run(JSON.stringify(control), row.execution_id, row.step_id);
    } finally {
      db.exec(sql);
    }
  })();
}
