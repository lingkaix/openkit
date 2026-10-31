import { expect, it } from 'vitest';
import { PreviewKnowledgeSchemaResponseSchema } from './knowledge-schema.js';

it('reports complete observed Workspace families without claiming migration or exposing incomplete inventory digests', () => {
  const families = ['maintenance', 'proposals', 'indexes', 'trace-references'] as const;
  const report = {
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    notebookRevision: 'a'.repeat(40),
    baseSchemaDigest: `sha256:${'b'.repeat(64)}`,
    candidateSchemaDigest: `sha256:${'c'.repeat(64)}`,
    coverage: 'workspace',
    completeMigration: false,
    inventoryComplete: true,
    records: [],
    schemaDiagnostics: [],
    dependencyInventory: families.map((family) => ({
      family,
      complete: true,
      records: [{ id: 'admitted-record', status: 'valid', diagnostics: [] }],
      diagnostics: [],
    })),
  };
  expect(PreviewKnowledgeSchemaResponseSchema.safeParse(report).success).toBe(true);
  const incomplete = {
    ...report,
    inventoryComplete: false,
    dependencyInventory: report.dependencyInventory.map((row) =>
      row.family === 'maintenance'
        ? {
            ...row,
            complete: false,
            records: [],
            diagnostics: [{ code: 'schema.inventory_unavailable' }],
          }
        : row
    ),
  };
  expect(PreviewKnowledgeSchemaResponseSchema.safeParse(incomplete).success).toBe(true);

  for (const invalid of [
    { ...report, coverage: 'notebook' },
    { ...report, completeMigration: true },
    { ...report, dependencyInventory: report.dependencyInventory.slice(1) },
    {
      ...report,
      dependencyInventory: [
        report.dependencyInventory[0],
        ...report.dependencyInventory.slice(0, 3),
      ],
    },
    { ...incomplete, inventoryComplete: true },
    {
      ...incomplete,
      dependencyInventory: incomplete.dependencyInventory.map((row) =>
        row.complete ? row : { ...row, inventoryDigest: `sha256:${'d'.repeat(64)}` }
      ),
    },
    {
      ...report,
      dependencyInventory: report.dependencyInventory.map((row) => ({
        ...row,
        diagnostics: [{ code: 'schema.invalid_record', body: 'Private retained content.' }],
      })),
    },
  ]) {
    expect(PreviewKnowledgeSchemaResponseSchema.safeParse(invalid).success).toBe(false);
  }
});
