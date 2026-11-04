// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const POLICY_SPECIFIER = /(^|\/)policy(?:[./-]|$)/i;

/** Returns every TypeScript or JavaScript file under the package, excluding installed output. */
function packageFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return packageFiles(path);
    return SOURCE_FILE.test(entry.name) ? [path] : [];
  });
}

/** Returns the module specifiers of static, re-export, and dynamic imports in one file. */
function importSpecifiers(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const specifiers: string[] = [];
  const add = (node: ts.Expression | undefined): void => {
    if (node && ts.isStringLiteral(node)) specifiers.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/** Names the boundary rule one specifier breaks, or returns null when it is allowed. */
function boundaryViolation(importer: string, specifier: string): string | null {
  if (specifier === 'apps/web' || specifier.startsWith('apps/web/')) {
    return 'imports the OpenKit web app';
  }
  if (specifier === '@openkit/core-client' || specifier.startsWith('@openkit/core-client/')) {
    return 'imports the OpenKit core client';
  }
  if (specifier === '@openkit/policy-kernel' || specifier.startsWith('@openkit/policy-kernel/')) {
    return 'imports the policy kernel';
  }
  if (POLICY_SPECIFIER.test(specifier)) return 'imports a policy module';
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const resolved = resolve(dirname(importer), specifier).split(sep).join('/');
    if (/\/apps\/web(\/|$)/.test(resolved)) return 'imports the OpenKit web app';
  }
  return null;
}

it('keeps packages/knowledge-ui free of host, core-client, and policy imports', () => {
  const files = packageFiles(PACKAGE_ROOT);
  const violations = files.flatMap((file) =>
    importSpecifiers(file).flatMap((specifier) => {
      const reason = boundaryViolation(file, specifier);
      return reason ? [`${relative(PACKAGE_ROOT, file)} imports ${specifier}: ${reason}`] : [];
    })
  );

  expect(files.length).toBeGreaterThan(0);
  expect(violations).toEqual([]);
});

it('rejects each forbidden dependency while allowing react-aria-components', () => {
  const importer = join(PACKAGE_ROOT, 'src', 'KnowledgeBrowser.tsx');

  expect(boundaryViolation(importer, 'apps/web/src/primitives')).toBe(
    'imports the OpenKit web app'
  );
  expect(boundaryViolation(importer, '../../../apps/web/src/primitives')).toBe(
    'imports the OpenKit web app'
  );
  expect(boundaryViolation(importer, '@openkit/core-client')).toBe(
    'imports the OpenKit core client'
  );
  expect(boundaryViolation(importer, '@openkit/policy-kernel')).toBe('imports the policy kernel');
  expect(boundaryViolation(importer, '@openkit/app-api-schemas/policy')).toBe(
    'imports a policy module'
  );
  expect(boundaryViolation(importer, './policy-kernel')).toBe('imports a policy module');
  expect(boundaryViolation(importer, 'react-aria-components')).toBeNull();
});
