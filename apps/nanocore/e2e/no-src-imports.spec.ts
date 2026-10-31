import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Repository root, three levels above `apps/nanocore/e2e`. */
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

/** Script extensions the boundary covers, including the `.mjs` e2e runners. */
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];

/** Test-runner helpers whose first argument is a module specifier to replace. */
const MODULE_REFERENCE_METHODS = new Set([
  'doMock',
  'importActual',
  'importMock',
  'mock',
  'unstable_mockModule',
]);

/** The three directories one boundary scan compares. */
interface ImportBoundaryRoots {
  /** Directory whose script files are scanned. */
  readonly e2eRoot: string;
  /** Directory that e2e files must not import. */
  readonly srcRoot: string;
  /** Directory that non-relative `apps/nanocore/src/` specifiers are joined to. */
  readonly baseRoot: string;
}

/**
 * Renders one path with `/` separators so relative output is stable across platforms.
 */
function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/**
 * Lists every script file under the e2e directory, including `.mjs` and `.js` runners.
 */
function listScriptFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);

    if (statSync(path).isDirectory()) {
      return listScriptFiles(path);
    }

    return SCANNED_EXTENSIONS.some((extension) => path.endsWith(extension)) ? [path] : [];
  });
}

/**
 * Reads the string literal a module-reference expression carries, if it carries one.
 */
function literalSpecifier(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

/**
 * Collects every module specifier the file references, in any import form.
 *
 * The whole parsed source is visited rather than filtered by line, so a multi-line
 * import declaration, a re-export, an `import()` expression, an `import type`
 * reference, a `require()` call and a test-runner mock specifier all appear in the
 * result. Quoted text that merely names a path is not a module reference and does
 * not appear here, which keeps a path used as a child-process argument admissible.
 */
function referencedModuleSpecifiers(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    /\.(?:mjs|cjs|js|jsx)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  );
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = literalSpecifier(node.moduleSpecifier);
      if (specifier !== undefined) specifiers.push(specifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = literalSpecifier(node.moduleReference.expression);
      if (specifier !== undefined) specifiers.push(specifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const specifier = literalSpecifier(node.argument.literal);
      if (specifier !== undefined) specifiers.push(specifier);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isModuleReference =
        ts.isPropertyAccessExpression(callee) && MODULE_REFERENCE_METHODS.has(callee.name.text);

      if (isDynamicImport || isRequire || isModuleReference) {
        const specifier = literalSpecifier(node.arguments[0]);
        if (specifier !== undefined) specifiers.push(specifier);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return specifiers;
}

/**
 * Reports whether one specifier from `fileName` resolves into the protected source root.
 *
 * Relative specifiers resolve against the referring file, so `../src/x` and
 * `../../src/x` are judged by where they land rather than by their spelling. Package
 * imports and paths outside the source root do not count.
 */
function resolvesIntoSource(
  roots: ImportBoundaryRoots,
  fileName: string,
  specifier: string
): boolean {
  const withoutQuery = specifier.split(/[?#]/)[0] ?? specifier;
  let target: string;

  if (withoutQuery.startsWith('.')) {
    target = resolve(dirname(fileName), withoutQuery);
  } else {
    // A bare `apps/nanocore/src/...` reference, whether written as a package path or as
    // an absolute path, names the same tree. Package imports carry no such segment.
    const markerIndex = withoutQuery.indexOf('apps/nanocore/src/');
    if (markerIndex < 0) {
      return false;
    }
    target = resolve(roots.baseRoot, withoutQuery.slice(markerIndex));
  }

  return target === roots.srcRoot || target.startsWith(`${roots.srcRoot}${sep}`);
}

/**
 * Finds the e2e files that import the protected source root, as repository-relative paths.
 */
function findSourceImportOffenders(roots: ImportBoundaryRoots): string[] {
  return listScriptFiles(roots.e2eRoot)
    .filter((path) =>
      referencedModuleSpecifiers(path, readFileSync(path, 'utf8')).some((specifier) =>
        resolvesIntoSource(roots, path, specifier)
      )
    )
    .map((path) => toPosix(relative(roots.baseRoot, path)))
    .sort();
}

/**
 * Builds an isolated tree that mirrors the real `apps/nanocore/{e2e,src}` layout, so one
 * fixture runs through the same scan and the same relative distances as the repository.
 */
function withFixtureTree(
  fixtures: Readonly<Record<string, string>>,
  assertion: (roots: ImportBoundaryRoots) => void
): void {
  const root = mkdtempSync(join(tmpdir(), 'openkit-e2e-boundary-'));
  try {
    mkdirSync(join(root, 'apps', 'nanocore', 'src'), { recursive: true });
    mkdirSync(join(root, 'apps', 'nanocore', 'e2e'), { recursive: true });
    for (const [path, text] of Object.entries(fixtures)) {
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text);
    }
    assertion({
      baseRoot: root,
      e2eRoot: join(root, 'apps', 'nanocore', 'e2e'),
      srcRoot: join(root, 'apps', 'nanocore', 'src'),
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe('nanocore e2e import boundary', () => {
  it('does not import nanocore source internals', () => {
    const offenders = findSourceImportOffenders({
      baseRoot: REPO_ROOT,
      e2eRoot: join(REPO_ROOT, 'apps', 'nanocore', 'e2e'),
      srcRoot: join(REPO_ROOT, 'apps', 'nanocore', 'src'),
    });

    // A violation means an L3 e2e spec coupled its observation to a NanoCore internal
    // module instead of the built process and its public operations.
    expect(offenders).toEqual([]);
  });

  it('scans the JavaScript runners as well as the TypeScript specs', () => {
    const e2eRoot = join(REPO_ROOT, 'apps', 'nanocore', 'e2e');
    const scanned = listScriptFiles(e2eRoot).map((path) => toPosix(relative(e2eRoot, path)));

    expect(scanned).toContain('pi-ai-real-provider-runner.mjs');
    expect(scanned).toContain('task-mode-real-worker-runner.test.mjs');
    expect(scanned).toContain('boot-empty.spec.ts');
    expect(scanned).toContain('_lib/harness.ts');
  });

  describe.each([
    [
      'a single-line static import',
      'apps/nanocore/e2e/case-a.spec.ts',
      "import { boot } from '../src/boot.js';\n",
    ],
    [
      'a multi-line static import',
      'apps/nanocore/e2e/case-b.spec.ts',
      "import {\n  boot,\n  shutdown,\n} from '../src/boot.js';\n",
    ],
    [
      'a dynamic import expression',
      'apps/nanocore/e2e/case-c.spec.ts',
      "await import('../src/boot.js');\n",
    ],
    [
      'a mock specifier',
      'apps/nanocore/e2e/case-d.spec.ts',
      "vi.mock('../src/boot.js', () => ({ boot: vi.fn() }));\n",
    ],
    [
      'a re-export from source',
      'apps/nanocore/e2e/case-e.spec.ts',
      "export { boot } from '../src/boot.js';\n",
    ],
    [
      'an import type reference',
      'apps/nanocore/e2e/case-f.spec.ts',
      "type Boot = import('../src/boot.js').Boot;\n",
    ],
    [
      'a require call',
      'apps/nanocore/e2e/case-g.spec.ts',
      "const boot = require('../src/boot.js');\n",
    ],
    [
      'an .mjs runner import',
      'apps/nanocore/e2e/case-h.mjs',
      "import { boot } from '../src/boot.js';\n",
    ],
    [
      'a commonjs runner require',
      'apps/nanocore/e2e/case-i.cjs',
      "const boot = require('../src/boot.js');\n",
    ],
    [
      'a nested helper import',
      'apps/nanocore/e2e/_lib/case-j.ts',
      "import { boot } from '../../src/runtime/boot.js';\n",
    ],
    [
      'an absolute source specifier',
      'apps/nanocore/e2e/case-k.spec.ts',
      "import { boot } from '/apps/nanocore/src/boot.js';\n",
    ],
  ])('reports an offender for %s', (_form, path, text) => {
    it('flags the file', () => {
      withFixtureTree(
        { [path]: text, 'apps/nanocore/src/boot.ts': 'export const boot = 1;\n' },
        (roots) => {
          expect(findSourceImportOffenders(roots)).toEqual([path]);
        }
      );
    });
  });

  it('reports no offender for built artifacts, packages, and quoted path text', () => {
    const fixtures = {
      'apps/nanocore/src/boot.ts': 'export const boot = 1;\n',
      'apps/nanocore/e2e/allowed.spec.ts': [
        "import { shutdown } from '../../dist/storage/control-store-worker-client.js';",
        "import { spawn } from 'node:child_process';",
        "import { helper } from './_lib/harness.js';",
        "const stub = join(repoRoot, 'apps/nanocore/src/test-support/mcp-stdio-stub.mjs');",
        "const note = 'do not import ../src/boot.js here';",
        "const config = 'src/boot.ts';",
      ].join('\n'),
      'apps/nanocore/e2e/_lib/harness.ts': "import { join } from 'node:path';\n",
    };

    withFixtureTree(fixtures, (roots) => {
      expect(findSourceImportOffenders(roots)).toEqual([]);
    });
  });
});
