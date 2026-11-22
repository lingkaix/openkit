// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';
import { describe, expect, it } from 'vitest';

/**
 * ia.md §4: words that never appear in daily UI copy.
 * They stay allowed in Details (the Inspector) and Diagnostics, which show records as they are.
 */
const BANNED: readonly { word: string; pattern: RegExp }[] = [
  { word: 'admission', pattern: /\badmission\b/i },
  { word: 'counted from records', pattern: /counted from records/i },
  { word: 'deterministic', pattern: /\bdeterministic/i },
  { word: 'revision protected', pattern: /revision protected/i },
  { word: 'logical', pattern: /\blogical\b/i },
  { word: 'Action Center', pattern: /\bAction Center\b/i },
  { word: 'Activity type unknown', pattern: /Activity type unknown/i },
  { word: 'Worker Task', pattern: /\bWorker Task\b/i },
  { word: 'Effort', pattern: /\bEffort\b/ },
  { word: 'Debug', pattern: /\bDebug\b/ },
];

/** Details and Diagnostics surfaces, relative to `src/`. */
const ALLOWED_FILES = new Set([
  'screens/settings/DiagnosticsScreen.tsx',
  'screens/chat/timeline/Inspector.tsx',
]);

/** Plain `.ts` modules that hold only user copy. */
const COPY_MODULES = [
  'screens/chat/timeline/copy.ts',
  'screens/chat/timeline/notices.ts',
  'screens/chat/timeline/toast-policy.ts',
];

/** JSX attributes that carry identifiers, routes or styling, never display text. */
const CODE_ATTRIBUTES = new Set([
  'as',
  'autoComplete',
  'className',
  'data-testid',
  'defaultSelectedKey',
  'elementType',
  'form',
  'headingLevel',
  'href',
  'htmlFor',
  'icon',
  'id',
  'inputMode',
  'key',
  'kind',
  'labelElementType',
  'lang',
  'look',
  'method',
  'mode',
  'name',
  'orientation',
  'path',
  'placement',
  'rel',
  'role',
  'selectedKey',
  'size',
  'slot',
  'src',
  'status',
  'target',
  'to',
  'tone',
  'type',
  'value',
  'variant',
]);

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..');

type Node = { type?: unknown; start?: number; [key: string]: unknown };

function isNode(value: unknown): value is Node {
  return Boolean(value) && typeof (value as Node).type === 'string';
}

/** Display strings in one source file: JSX text, string literals and template text. */
function displayStrings(file: string, text: string): { line: number; value: string }[] {
  const { program } = parseSync(file, text, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' });
  const found: { line: number; value: string }[] = [];
  const lineOf = (position = 0) => text.slice(0, position).split('\n').length;
  const visit = (node: Node, parent: Node | null, key: string | null) => {
    const type = String(node.type);
    if (
      type === 'ImportDeclaration' ||
      type === 'ExportAllDeclaration' ||
      (type === 'ExportNamedDeclaration' && node.source) ||
      (type.startsWith('TS') &&
        type !== 'TSAsExpression' &&
        type !== 'TSSatisfiesExpression' &&
        type !== 'TSNonNullExpression')
    ) {
      return;
    }
    if (type === 'JSXAttribute') {
      const name = (node.name as { name?: unknown } | undefined)?.name;
      if (typeof name === 'string' && CODE_ATTRIBUTES.has(name)) return;
    }
    // Comparisons and switch cases match values; they never render.
    if (type === 'BinaryExpression' || (parent?.type === 'SwitchCase' && key === 'test')) return;
    if (type === 'JSXText' && typeof node.value === 'string') {
      found.push({ line: lineOf(node.start), value: node.value });
    } else if (type === 'Literal' && typeof node.value === 'string') {
      const isKey =
        (parent?.type === 'Property' && key === 'key') ||
        (parent?.type === 'MemberExpression' && key === 'property');
      if (!isKey) found.push({ line: lineOf(node.start), value: node.value });
    } else if (type === 'TemplateElement') {
      const cooked = (node.value as { cooked?: unknown } | undefined)?.cooked;
      if (typeof cooked === 'string') found.push({ line: lineOf(node.start), value: cooked });
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (childKey === 'parent') continue;
      if (Array.isArray(child)) {
        for (const item of child) if (isNode(item)) visit(item, node, childKey);
      } else if (isNode(child)) {
        visit(child, node, childKey);
      }
    }
  };
  visit(program as unknown as Node, null, null);
  return found;
}

/** Banned words in one file, as `path:line: word`. */
function bannedCopy(file: string, text: string): string[] {
  const hits: string[] = [];
  for (const { line, value } of displayStrings(file, text)) {
    for (const { word, pattern } of BANNED) {
      if (pattern.test(value)) hits.push(`${file}:${line}: ${word}`);
    }
  }
  return hits;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__fixtures__') sourceFiles(path, out);
    } else if (path.endsWith('.tsx') && !path.endsWith('.test.tsx')) {
      out.push(path);
    }
  }
  return out;
}

describe('daily UI copy (ia.md §4)', () => {
  it('uses no banned word outside Details and Diagnostics', () => {
    const files = [
      ...sourceFiles(srcRoot).map((path) => relative(srcRoot, path)),
      ...COPY_MODULES,
    ].filter((file) => !ALLOWED_FILES.has(file));
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap((file) =>
      bannedCopy(file, readFileSync(join(srcRoot, file), 'utf8'))
    );
    expect(hits).toEqual([]);
  });

  it('finds a banned word in JSX text, an attribute, a literal and a template', () => {
    const planted = [
      'const a = <p>Open the Action Center</p>;',
      'const b = <Button aria-label="Effort">x</Button>;',
      "const c = { label: 'Logical model' };",
      // A template literal with one placeholder, built so this file has none.
      ['const d = `$', '{n} counted from records`;'].join(''),
    ].join('\n');
    expect(bannedCopy('planted.tsx', planted)).toEqual([
      'planted.tsx:1: Action Center',
      'planted.tsx:2: Effort',
      'planted.tsx:3: logical',
      'planted.tsx:4: counted from records',
    ]);
  });

  it('ignores identifiers, routes, class names, keys and comparisons', () => {
    const code = [
      "import { admission } from './admission';",
      'const e = <Link to="/settings/debug" className="logical">Diagnostics</Link>;',
      "const f = { 'deterministic': 1 }; if (kind === 'admission') f.deterministic;",
      "switch (kind) { case 'Effort': break; }",
    ].join('\n');
    expect(bannedCopy('ignored.tsx', code)).toEqual([]);
  });
});
