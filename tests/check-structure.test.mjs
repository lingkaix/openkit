import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  analyzeStructure,
  D4_BAND,
  emptyBaseline,
  evaluateBaseline,
  PRIMITIVE_OWNERS,
  shrinkBaseline,
  snapshotBaseline,
} from '../scripts/check-structure.mjs';

const script = fileURLToPath(new URL('../scripts/check-structure.mjs', import.meta.url));

function withTree(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'check-structure-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function hasKey(findings, detector, pattern) {
  return Object.keys(findings[detector]).some((key) => pattern.test(key));
}

const framed = [
  "import { createHash } from 'node:crypto';",
  'export function hash(value: unknown) {',
  "  return createHash('sha256').update(JSON.stringify(value)).digest('hex');",
  '}',
  '',
].join('\n');

test('D1 finds canonical JSON, digest framing and Workspace denials outside their owners', () => {
  const files = {
    'apps/nanocore/src/bad.ts': [
      "import { createHash } from 'node:crypto';",
      'export function stableStringify(value: unknown) { return JSON.stringify(value); }',
      'export function pack(value: Record<string, unknown>) {',
      '  const keys = Object.keys(value).sort();',
      '  return JSON.stringify(keys);',
      '}',
      'export function show(value: Record<string, unknown>, rows: string[]) {',
      '  rows.sort();',
      '  return JSON.stringify(Object.keys(value));',
      '}',
      "export function deny() { throw new OperationError('workspace_access_denied', 'no', 403); }",
      "export function denied() { return { kind: 'denied', code: 'workspace_access_denied' }; }",
      "export function other() { throw new OperationError('forbidden', 'no', 403); }",
      "export function compare(code: string) { if (code === 'workspace_access_denied') return false; return true; }",
      'export function viaLocal(value: unknown) {',
      '  const text = JSON.stringify(value);',
      "  const hash = createHash('sha256');",
      '  hash.update(text);',
      "  return hash.digest('hex');",
      '}',
      'export function viaName(value: unknown) {',
      "  return createHash('sha256').update(stableStringify(value)).digest('hex');",
      '}',
      'export function raw(value: Buffer) {',
      "  return createHash('sha256').update(value).digest('hex');",
      '}',
      '',
    ].join('\n'),
    'apps/nanocore/src/operation-error.ts':
      "export const DENIED = () => { throw new Error('workspace_access_denied'); };\n",
    'apps/nanocore/src/owned.ts': framed,
    'apps/nanocore/src/skip.test.ts': framed,
    'apps/nanocore/src/sample.fixture.ts': framed,
    'apps/nanocore/src/types.d.ts': 'export function stableStringify(v: unknown): string;\n',
    'apps/nanocore/src/test-support/hidden.ts': framed,
    'apps/nanocore/src/generated/gen.ts': framed,
    'scripts/nope.ts':
      'export function stableStringify(v: unknown) { return JSON.stringify(v); }\n',
    'apps/nanocore/src/gen-header.ts':
      '/* @generated */\nexport function stableStringify(v: unknown) { return JSON.stringify(v); }\n',
  };
  withTree(files, (root) => {
    const owners = { ...PRIMITIVE_OWNERS, 'digest-framing': ['apps/nanocore/src/owned.ts'] };
    const { findings } = analyzeStructure(root, { owners });
    assert.equal(hasKey(findings, 'D1', /bad\.ts :: stableStringify :: canonical-json$/), true);
    assert.equal(hasKey(findings, 'D1', /bad\.ts :: pack :: canonical-json$/), true);
    assert.equal(hasKey(findings, 'D1', /bad\.ts :: show ::/), false);
    assert.equal(
      hasKey(findings, 'D1', /bad\.ts :: deny :: auth-code:workspace_access_denied$/),
      true
    );
    assert.equal(
      hasKey(findings, 'D1', /bad\.ts :: denied :: auth-code:workspace_access_denied$/),
      true
    );
    assert.equal(hasKey(findings, 'D1', /bad\.ts :: (other|compare) ::/), false);
    assert.equal(hasKey(findings, 'D1', /bad\.ts :: viaLocal :: digest-framing$/), true);
    assert.equal(hasKey(findings, 'D1', /bad\.ts :: viaName :: digest-framing$/), true);
    assert.equal(hasKey(findings, 'D1', /bad\.ts :: raw ::/), false);
    assert.equal(hasKey(findings, 'D1', /owned\.ts|operation-error\.ts/), false);
    assert.equal(
      hasKey(
        findings,
        'D1',
        /skip\.test|fixture|types\.d\.ts|test-support|generated|gen-header|nope/
      ),
      false
    );
    assert.equal(evaluateBaseline(findings, emptyBaseline()).violations.length > 0, true);
    assert.equal(evaluateBaseline(findings, snapshotBaseline(findings)).violations.length, 0);
  });
});

test('D2 fails new value edges inside a cycle and ignores type-only imports', () => {
  withTree(
    {
      'apps/nanocore/src/cycle/a.ts': "import { b } from './b.js';\nexport const a = b;\n",
      'apps/nanocore/src/cycle/b.ts': "import { a } from './a.js';\nexport const b = 1;\n",
      'apps/nanocore/src/typed/a.ts':
        "import type { B } from './b.js';\nexport const a = 1;\nexport type A = number;\n",
      'apps/nanocore/src/typed/b.ts':
        "import { a } from './a.js';\nexport const b = a;\nexport type B = number;\n",
      'apps/nanocore/src/dyn/a.ts':
        "export const a = 1;\nexport const load = () => import('./b.js');\n",
      'apps/nanocore/src/dyn/b.ts': "import { a } from './a.js';\nexport const b = a;\n",
      'apps/nanocore/src/mix/a.ts':
        "import { type A, b } from './b.js';\nexport const a = b;\nexport type A = number;\n",
      'apps/nanocore/src/mix/b.ts':
        "import { a } from './a.js';\nexport const b = 1;\nexport type B = number;\n",
    },
    (root) => {
      const { findings } = analyzeStructure(root);
      assert.equal(hasKey(findings, 'D2', /cycle\/a\.ts -> .*cycle\/b\.ts$/), true);
      assert.equal(hasKey(findings, 'D2', /cycle\/b\.ts -> .*cycle\/a\.ts$/), true);
      assert.equal(hasKey(findings, 'D2', /typed\//), false);
      assert.equal(hasKey(findings, 'D2', /dyn\/a\.ts -> .*dyn\/b\.ts$/), true);
      assert.equal(hasKey(findings, 'D2', /mix\/a\.ts -> .*mix\/b\.ts$/), true);
      const red = evaluateBaseline(findings, emptyBaseline());
      assert.equal(
        red.violations.some((item) => item.detector === 'D2'),
        true
      );
      assert.equal(evaluateBaseline(findings, snapshotBaseline(findings)).violations.length, 0);
    }
  );
});

test('Signals are recorded but never compared with the baseline', () => {
  const depth = Math.max(6, D4_BAND);
  let body = 'return 1;';
  for (let index = 0; index < depth; index += 1) body = `if (a) { ${body} }`;
  const functions = Array.from({ length: 10 }, (_, index) => {
    const value = index < 2 ? 'return shared;' : `return ${index};`;
    return `export function f${index}() { ${value} }`;
  }).join('\n');
  withTree(
    {
      'apps/nanocore/src/complexity.ts': [
        'export function flat(a: number, b: number) { if (a) return 1; if (b) return 2; return 0; }',
        `export function deep(a: number) { ${body} }`,
        '',
      ].join('\n'),
      'apps/nanocore/src/klass.ts': [
        'export class Store {',
        '  a() { return this.hub + this.onlyA; }',
        '  b() { return this.hub + this.onlyB; }',
        '  c() { return this.onlyC; }',
        '}',
        '',
      ].join('\n'),
      'apps/nanocore/src/mod.ts': `const shared = 1;\n${functions}\n`,
      'apps/nanocore/src/scale.ts': [
        'type Store = { listThreads(id: string): number[] };',
        'export function bad(store: Store) { return store.listThreads("a").filter((item) => item > 0); }',
        'export function other(items: number[]) { return items.find((item) => item > 0); }',
        '',
      ].join('\n'),
      'apps/nanocore/src/pass.ts': [
        'export function forward(a: number) { return target(a); }',
        'export type T = number;',
        '',
      ].join('\n'),
    },
    (root) => {
      const { findings } = analyzeStructure(root);
      const deep = 'apps/nanocore/src/complexity.ts :: deep';
      assert.equal(findings.D4[deep].value, (depth * (depth + 1)) / 2);
      assert.equal(hasKey(findings, 'D4', /:: flat$/), false);
      assert.equal(findings.D5['apps/nanocore/src/klass.ts :: Store :: lcom4'].value, 3);
      assert.equal(findings.D5['apps/nanocore/src/mod.ts :: <module> :: lcom4'].value, 9);
      assert.equal(findings.D6['apps/nanocore/src/scale.ts :: bad :: listThreads.filter'].value, 1);
      assert.equal(hasKey(findings, 'D6', /:: other ::/), false);
      assert.equal(hasKey(findings, 'D7', /pass\.ts :: <module> :: pass-through$/), true);
      assert.deepEqual(evaluateBaseline(findings, emptyBaseline()), {
        violations: [],
        shrinkable: 0,
      });
      const report = spawnSync(process.execPath, [script, '--root', root, '--report'], {
        encoding: 'utf8',
      });
      assert.equal(report.status, 0, report.stderr);
      assert.match(report.stdout, /complexity\.ts:\d+ apps\/nanocore\/src\/complexity\.ts :: deep/);
    }
  );
});

test('--update removes vanished entries, lowers values, and never adds', () => {
  withTree({ 'apps/nanocore/src/owned.ts': framed }, (root) => {
    const { findings } = analyzeStructure(root);
    const key = 'apps/nanocore/src/owned.ts :: hash :: digest-framing';
    assert.equal(findings.D1[key].value, 1);
    const base = emptyBaseline();
    base.D1[key] = 4;
    base.D1['apps/nanocore/src/gone.ts :: hash :: digest-framing'] = 2;
    assert.equal(evaluateBaseline(findings, base).shrinkable, 2);
    assert.deepEqual(shrinkBaseline(base, findings), { D1: { [key]: 1 }, D2: {} });
    assert.deepEqual(shrinkBaseline(emptyBaseline(), findings), emptyBaseline());
    const lower = emptyBaseline();
    lower.D1[key] = 0;
    assert.equal(shrinkBaseline(lower, findings).D1[key], 0);
    assert.equal(evaluateBaseline(findings, lower).violations[0].kind, 'grew');

    const file = join(root, 'baseline.json');
    writeFileSync(file, `${JSON.stringify(base)}\n`);
    const run = spawnSync(
      process.execPath,
      [script, '--root', root, '--baseline', file, '--update'],
      {
        encoding: 'utf8',
      }
    );
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { D1: { [key]: 1 }, D2: {} });
  });
});

test('--init writes a snapshot once and refuses an existing baseline', () => {
  const source =
    'export function stableStringify(value: unknown) { return JSON.stringify(value); }\n';
  withTree({ 'apps/nanocore/src/keep.ts': source }, (root) => {
    const baseline = join(root, 'baseline.json');
    const args = [script, '--root', root, '--baseline', baseline, '--init'];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(readFileSync(baseline, 'utf8')), {
      D1: { 'apps/nanocore/src/keep.ts :: stableStringify :: canonical-json': 1 },
      D2: {},
    });
    const bytes = readFileSync(baseline, 'utf8');
    const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(second.status, 2);
    assert.match(second.stderr, /baseline already exists/);
    assert.equal(readFileSync(baseline, 'utf8'), bytes);
    rmSync(baseline);
    writeFileSync(
      join(root, 'apps/nanocore/src/new.ts'),
      source.replace('stableStringify', 'stableValueJson')
    );
    writeFileSync(baseline, `${JSON.stringify(emptyBaseline())}\n`);
    const red = spawnSync(process.execPath, [script, '--root', root, '--baseline', baseline], {
      encoding: 'utf8',
    });
    assert.equal(red.status, 1);
    assert.match(red.stdout, /new\.ts:1 D1 use the canonical-json owner/);
  });
});
