import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreviewKnowledgeSchemaResponse } from '@openkit/app-api-schemas';
import { canonicalJsonText, compareCodeUnits } from '@openkit/protocol';
import { expect, it, onTestFinished } from 'vitest';
import { NotebookError } from './notebook-error.js';
import {
  prepareSchemaApplicationHistory,
  readSchemaApplicationHistory,
  schemaApplicationResult,
  schemaReportBytes,
} from './schema-application.js';

const previousSchemaText = [
  'schema_version: "openkit-scope-knowledge-schema-v4"',
  'status: active',
  'allowed_types: [KnowledgePage]',
  'allowed_statuses: [stable]',
  'allowed_review_states: [user-authored]',
  'allowed_sensitivities: [normal]',
  'allowed_freshness: [current]',
  '',
].join('\n');
const candidateSchemaText = `${previousSchemaText}# Exact reviewed candidate.\n`;
const baseSchemaDigest = `sha256:${createHash('sha256').update(previousSchemaText).digest('hex')}`;
const candidateSchemaDigest = `sha256:${createHash('sha256')
  .update(candidateSchemaText)
  .digest('hex')}`;
const reviewedReport: PreviewKnowledgeSchemaResponse = {
  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  notebookRevision: '1111111111111111111111111111111111111111',
  baseSchemaDigest,
  candidateSchemaDigest,
  coverage: 'workspace',
  inventoryComplete: true,
  completeMigration: false,
  schemaDiagnostics: [],
  records: [{ path: 'reviewed.md', status: 'valid', diagnostics: [] }],
  dependencyInventory: ['maintenance', 'proposals', 'indexes', 'trace-references'].map(
    (family) => ({
      family: family as PreviewKnowledgeSchemaResponse['dependencyInventory'][number]['family'],
      complete: true,
      records: [],
      diagnostics: [],
      inventoryDigest: `sha256:${createHash('sha256').update('[]').digest('hex')}`,
    })
  ),
};
const actualReport: PreviewKnowledgeSchemaResponse = {
  ...reviewedReport,
  notebookRevision: '2222222222222222222222222222222222222222',
  records: [{ path: 'late-valid.md', status: 'valid', diagnostics: [] }, ...reviewedReport.records],
};
// S60 and the DatabaseOwner schema section require both the exact human review
// and the actual applied inventory; the retained marker is explicitly version 1.
const packet = { schemaVersion: 1, requiredFeatures: [], reviewedReport, actualReport };
const expectedBytes = canonicalJsonText(packet);
const reportDigest = `sha256:${createHash('sha256').update(expectedBytes).digest('hex')}`;
const expectedResult = {
  workspaceId: reviewedReport.workspaceId,
  notebookRevision: '2222222222222222222222222222222222222222',
  baseSchemaDigest,
  candidateSchemaDigest,
  reportDigest,
};

it('returns the original result with all three exact history members already published', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'schema-history-sync-'));
  onTestFinished(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  const historyRoot = join(workspaceRoot, 'knowledge', 'schema', 'history');
  const preparation = prepareSchemaApplicationHistory({
    workspaceRoot,
    previousSchemaText,
    candidateSchemaText,
    report: reviewedReport,
    actualReport,
  });
  // S60 requires durable schema/report preparation before the immediate native SQL reference.
  // Snapshot before any await, then join the old asynchronous owner before assertions or cleanup.
  let membersAtReturn: Array<{ name: string; text: string; mode: number }> = [];
  try {
    membersAtReturn = existsSync(historyRoot)
      ? readdirSync(historyRoot).map((name) => ({
          name,
          text: readFileSync(join(historyRoot, name), 'utf8'),
          mode: statSync(join(historyRoot, name)).mode & 0o777,
        }))
      : [];
  } finally {
    await preparation;
  }
  expect(membersAtReturn.sort((a, b) => compareCodeUnits(a.name, b.name))).toEqual(
    [
      { name: `${baseSchemaDigest.slice(7)}.yaml`, text: previousSchemaText, mode: 0o444 },
      { name: `${candidateSchemaDigest.slice(7)}.yaml`, text: candidateSchemaText, mode: 0o444 },
      { name: `${reportDigest.slice(7)}.json`, text: expectedBytes, mode: 0o444 },
    ].sort((a, b) => compareCodeUnits(a.name, b.name))
  );
  expect(preparation).toEqual(expectedResult);
  expect(readSchemaApplicationHistory(workspaceRoot, reportDigest)).toEqual(expectedResult);
});

it('preserves exact existing winners and their original result on repeated preparation', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'schema-history-existing-'));
  onTestFinished(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  const input = {
    workspaceRoot,
    previousSchemaText,
    candidateSchemaText,
    report: reviewedReport,
    actualReport,
  };
  const original = await prepareSchemaApplicationHistory(input);
  const historyRoot = join(workspaceRoot, 'knowledge', 'schema', 'history');
  const originalMembers = readdirSync(historyRoot).sort();
  const originalBytes = originalMembers.map((name) => readFileSync(join(historyRoot, name)));
  expect(await prepareSchemaApplicationHistory(input)).toEqual(expectedResult);
  expect(original).toEqual(expectedResult);
  expect(readdirSync(historyRoot).sort()).toEqual(originalMembers);
  expect(originalMembers.map((name) => readFileSync(join(historyRoot, name)))).toEqual(
    originalBytes
  );
  expect(readSchemaApplicationHistory(workspaceRoot, reportDigest)).toEqual(original);
});

it.each([
  { name: 'previous schema', digest: baseSchemaDigest, extension: 'yaml' },
  { name: 'candidate schema', digest: candidateSchemaDigest, extension: 'yaml' },
  { name: 'report pair', digest: reportDigest, extension: 'json' },
])('refuses a corrupt existing $name without overwriting retained bytes', async ({
  digest,
  extension,
}) => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'schema-history-winner-corruption-'));
  onTestFinished(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  const input = {
    workspaceRoot,
    previousSchemaText,
    candidateSchemaText,
    report: reviewedReport,
    actualReport,
  };
  await prepareSchemaApplicationHistory(input);
  const historyRoot = join(workspaceRoot, 'knowledge', 'schema', 'history');
  const corruptedPath = join(historyRoot, `${digest.slice(7)}.${extension}`);
  // Corrupt an owner-published winner at the same byte length, so existence and size are insufficient.
  const corruptedBytes = Buffer.from(readFileSync(corruptedPath));
  corruptedBytes[0] = corruptedBytes[0]! ^ 1;
  chmodSync(corruptedPath, 0o644);
  writeFileSync(corruptedPath, corruptedBytes);
  const originalMembers = readdirSync(historyRoot).sort();
  const retainedBytes = originalMembers.map((name) => readFileSync(join(historyRoot, name)));
  await expect(
    Promise.resolve().then(() => prepareSchemaApplicationHistory(input))
  ).rejects.toThrow();
  expect(readdirSync(historyRoot).sort()).toEqual(originalMembers);
  expect(originalMembers.map((name) => readFileSync(join(historyRoot, name)))).toEqual(
    retainedBytes
  );
});

it('retains both exact reports and replays the applied Notebook revision', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'schema-history-pair-'));
  onTestFinished(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  expect(schemaReportBytes(reviewedReport, actualReport)).toBe(expectedBytes);
  expect(schemaApplicationResult(reviewedReport, actualReport)).toEqual(expectedResult);
  const result = await prepareSchemaApplicationHistory({
    workspaceRoot,
    previousSchemaText,
    candidateSchemaText,
    report: reviewedReport,
    actualReport,
  });
  expect(result).toEqual(expectedResult);
  const historyRoot = join(workspaceRoot, 'knowledge', 'schema', 'history');
  const reportPath = join(historyRoot, `${reportDigest.slice(7)}.json`);
  expect(readFileSync(reportPath, 'utf8')).toBe(expectedBytes);
  expect(readFileSync(join(historyRoot, `${baseSchemaDigest.slice(7)}.yaml`), 'utf8')).toBe(
    previousSchemaText
  );
  expect(readFileSync(join(historyRoot, `${candidateSchemaDigest.slice(7)}.yaml`), 'utf8')).toBe(
    candidateSchemaText
  );
  expect(readSchemaApplicationHistory(workspaceRoot, reportDigest)).toEqual(expectedResult);
  expect(readFileSync(reportPath, 'utf8')).toBe(expectedBytes);

  // A valid publication followed by deliberate retained-byte corruption must not
  // replay an invented result, even when the JSON still parses after the change.
  chmodSync(reportPath, 0o644);
  writeFileSync(reportPath, `${expectedBytes}\n`);
  expect(() => readSchemaApplicationHistory(workspaceRoot, reportDigest)).toThrowError(
    expect.objectContaining({ code: 'recovery_required' })
  );
});

it.each([
  {
    name: 'another Workspace',
    actual: { ...actualReport, workspaceId: 'ws_00000000-0000-7000-8000-000000000002' },
  },
  {
    name: 'another base schema',
    actual: { ...actualReport, baseSchemaDigest: candidateSchemaDigest },
  },
  {
    name: 'another candidate',
    actual: { ...actualReport, candidateSchemaDigest: baseSchemaDigest },
  },
])('refuses history publication for $name in the actual report', async ({ actual }) => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'schema-history-mismatch-'));
  onTestFinished(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  await expect(
    Promise.resolve().then(() =>
      prepareSchemaApplicationHistory({
        workspaceRoot,
        previousSchemaText,
        candidateSchemaText,
        report: reviewedReport,
        actualReport: actual,
      })
    )
  ).rejects.toBeInstanceOf(NotebookError);
  const historyRoot = join(workspaceRoot, 'knowledge', 'schema', 'history');
  expect(existsSync(historyRoot) ? readdirSync(historyRoot) : []).toEqual([]);
});

it.each([
  {
    name: 'reviewed-only evidence',
    record: { schemaVersion: 1, requiredFeatures: [], reviewedReport },
  },
  {
    name: 'another actual Workspace',
    record: {
      ...packet,
      actualReport: { ...actualReport, workspaceId: 'ws_00000000-0000-7000-8000-000000000002' },
    },
  },
  {
    name: 'another actual base',
    record: {
      ...packet,
      actualReport: { ...actualReport, baseSchemaDigest: candidateSchemaDigest },
    },
  },
  {
    name: 'another actual candidate',
    record: {
      ...packet,
      actualReport: { ...actualReport, candidateSchemaDigest: baseSchemaDigest },
    },
  },
  {
    name: 'unsupported required semantics',
    record: { ...packet, requiredFeatures: ['openkit.schema.future.v1'] },
  },
  {
    name: 'unknown actual core status',
    record: {
      ...packet,
      actualReport: {
        ...actualReport,
        records: [{ path: 'late-valid.md', status: 'unrecognized', diagnostics: [] }],
      },
    },
  },
])('refuses digest-correct $name during original-result replay', async ({ record }) => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'schema-history-corruption-'));
  onTestFinished(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  await prepareSchemaApplicationHistory({
    workspaceRoot,
    previousSchemaText,
    candidateSchemaText,
    report: reviewedReport,
    actualReport,
  });
  // Deliberate corruption after valid owner setup: a matching digest must not
  // turn a missing or contradictory retained core into a valid original result.
  const bytes = canonicalJsonText(record);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const corruptionPath = join(
    workspaceRoot,
    'knowledge',
    'schema',
    'history',
    `${digest.slice(7)}.json`
  );
  // The old owner can already have published this digest as a read-only file.
  if (existsSync(corruptionPath)) chmodSync(corruptionPath, 0o644);
  writeFileSync(corruptionPath, bytes);
  expect(() => readSchemaApplicationHistory(workspaceRoot, digest)).toThrowError(
    expect.objectContaining({ code: 'recovery_required' })
  );
});
