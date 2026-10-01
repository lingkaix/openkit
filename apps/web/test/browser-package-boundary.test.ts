// @vitest-environment node
import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import { expect, it } from 'vitest';

/** Finds Node globals in shipped modules, including delayed schema refinements. */
function nodeGlobals(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && ['Buffer', 'process', '__dirname'].includes(node.text)) {
      const parent = node.parent;
      // A property or exported name such as Zod's `process` is not a global reference.
      const namedMember =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        ts.isExportSpecifier(parent) ||
        ts.isImportSpecifier(parent);
      if (!namedMember) violations.push(`${path}: uses ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

it('keeps the built browser package entries free of Node imports and globals', async () => {
  const violations: string[] = [];
  // Browser resolution follows the built package exports, not Vitest's source transforms.
  const result = await build({
    stdin: {
      contents: [
        "import '@openkit/app-api-schemas';",
        "import '@openkit/core-client';",
        "import '@openkit/protocol';",
      ].join('\n'),
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
    plugins: [
      {
        name: 'observe-node-imports',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (!isBuiltin(args.path)) return;
            violations.push(`${args.importer}: imports ${args.path}`);
            // Only the test externalizes these imports so it can collect every violation.
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });
  for (const path of Object.keys(result.metafile.inputs)) {
    if (path !== '<stdin>') violations.push(...nodeGlobals(resolve(path)));
  }
  expect([...new Set(violations)].sort()).toEqual([]);
});
