import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import ts from 'typescript6';
import { describe, expect, it } from 'vitest';

const nanoCoreRoot = fileURLToPath(new URL('../../', import.meta.url));
const repositoryRoot = resolve(nanoCoreRoot, '../..');
const drizzleRoot = join(nanoCoreRoot, 'drizzle');

const scopeConfigs = import.meta.glob<{ out: string }>('../../drizzle.*.config.ts', {
  eager: true,
  import: 'default',
});
const ownerModules = import.meta.glob<Record<string, unknown>>(
  ['./*-owner.ts', './*-store-descriptor.ts', './*-schema.ts', './*-port.ts'],
  { eager: true }
);

type OwnerDescriptor = {
  readonly owner: string;
  readonly requiredTables: readonly string[];
  readonly journalFolder?: string;
};

function isOwnerDescriptor(value: unknown): value is OwnerDescriptor {
  return (
    typeof value === 'object' &&
    value !== null &&
    'owner' in value &&
    typeof value.owner === 'string' &&
    'requiredTables' in value &&
    Array.isArray(value.requiredTables)
  );
}

// StorageOwner is erased at runtime. Read its literal members from the owning declaration.
function registeredOwnerIds(): string[] {
  const path = fileURLToPath(new URL('./storage-owner.ts', import.meta.url));
  const registry = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest);
  const owners = registry.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === 'StorageOwner'
  );
  if (!owners || !ts.isUnionTypeNode(owners.type)) throw new Error('Missing StorageOwner registry');
  return owners.type.types.map((owner) => {
    if (!ts.isLiteralTypeNode(owner) || !ts.isStringLiteral(owner.literal)) {
      throw new Error('StorageOwner must name a storage owner');
    }
    return owner.literal.text;
  });
}

const owners = Object.values(ownerModules)
  .flatMap((module) => Object.values(module))
  .filter(isOwnerDescriptor);
const landedOwnerFolders = ['services', 'extensions'].flatMap((group) => {
  const container = join(drizzleRoot, group);
  return readdirSync(container, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(container, entry.name));
});
const registered = new Set(registeredOwnerIds());
const ownerJournals = landedOwnerFolders.filter((folder) => registered.has(basename(folder)));
const scopeJournals = Object.values(scopeConfigs).map((config) =>
  resolve(nanoCoreRoot, config.out)
);
const journals = [...new Set([...scopeJournals, ...ownerJournals])].sort();

function retainedTagChecks(definition: string): string[] {
  // Keep quoted SQL and comments whole so parentheses in them cannot change the CHECK boundary.
  const tokens = (
    definition.match(
      /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|\w+|==|[^\s]/g
    ) ?? []
  ).filter((token) => !token.startsWith('--') && !token.startsWith('/*'));
  const checks: string[] = [];
  for (let start = 0; start < tokens.length - 1; start += 1) {
    if (tokens[start].toLowerCase() !== 'check' || tokens[start + 1] !== '(') continue;
    let depth = 1;
    let end = start + 2;
    for (; depth > 0 && end < tokens.length; end += 1) {
      if (tokens[end] === '(') depth += 1;
      if (tokens[end] === ')') depth -= 1;
    }
    const predicate = tokens
      .slice(start + 2, end - 1)
      .filter((token) => token !== '(' && token !== ')')
      .map((token) =>
        /^(?:schema_version|"schema_version"|`schema_version`|\[schema_version\])$/i.test(token)
          ? 'schema_version'
          : token
      );
    if (predicate.includes('schema_version')) checks.push(predicate.join(' '));
    start = end - 1;
  }
  return checks;
}

describe('storage cutover baseline', () => {
  it('covers the registered scope and owner journals', () => {
    expect(scopeJournals).not.toHaveLength(0);
    expect(owners).not.toHaveLength(0);
    expect(ownerJournals).toEqual(landedOwnerFolders);
    for (const { owner, journalFolder } of owners) {
      expect(registered).toContain(owner);
      const matches = ownerJournals.filter((path) =>
        journalFolder ? path === resolve(nanoCoreRoot, journalFolder) : basename(path) === owner
      );
      expect(matches, owner).toHaveLength(1);
    }
  });

  it.each(journals.map((folder) => [relative(drizzleRoot, folder), folder] as const))(
    '%s has one baseline at index zero and v1 retained SQL tags',
    (_journal, folder) => {
      const files = readdirSync(folder).filter((name) => name.endsWith('.sql'));
      expect(files).toEqual(['0000_baseline.sql']);
      const metadata = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8'));
      expect(metadata.entries).toEqual([expect.objectContaining({ idx: 0, tag: '0000_baseline' })]);

      const sqlite = new DatabaseSync(':memory:');
      try {
        sqlite.exec(readFileSync(join(folder, files[0]), 'utf8'));
        const columns = sqlite
          .prepare(
            `SELECT tables.name AS name, columns.dflt_value AS tag, tables.sql AS definition
           FROM sqlite_schema AS tables JOIN pragma_table_info(tables.name) AS columns
           WHERE tables.type = 'table' AND columns.name = 'schema_version'`
          )
          .all() as { name: string; tag: string | null; definition: string }[];
        for (const { name, tag, definition } of columns) {
          if (tag !== null) expect(tag, `${name}.schema_version default`).toBe('1');
          for (const check of retainedTagChecks(definition)) {
            expect(check, `${name}.schema_version CHECK`).toMatch(
              /^(?:schema_version ={1,2} 1|1 ={1,2} schema_version)$/
            );
          }
          const table = `"${name.replaceAll('"', '""')}"`;
          const invalid = sqlite
            .prepare(`SELECT 1 FROM ${table} WHERE schema_version IS NOT 1`)
            .get();
          expect(invalid, `${name}.schema_version seed`).toBeUndefined();
        }
      } finally {
        sqlite.close();
      }
    }
  );
});

describe('storage cutover report mode', () => {
  it.each([
    ['table-partition', /^table-partition-oracle: (PASS|FAIL)\r?$/m],
    ['removed-lookup', /^removed-lookup-oracle: (FAIL|NO-HITS .+)\r?$/m],
  ] as const)('produces a %s report for the candidate source', (oracle, verdict) => {
    const report = execFileSync(process.execPath, [`scripts/storage-${oracle}-oracle.mjs`], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(report).toMatch(verdict);
  });
});
