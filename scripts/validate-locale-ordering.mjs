#!/usr/bin/env node
/** Blocks locale-dependent machine ordering in production sources. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// #532: exact held expressions only. Remove each entry with its owning cut.
// BEGIN DEFERRED COMPARISONS
const deferredComparisons = {};
// END DEFERRED COMPARISONS

/** Reports direct locale comparisons beyond each named, deferred source expression. */
export function unexpectedLocaleComparisons(path, source) {
  const allowed = new Map(Object.entries(deferredComparisons[path] ?? {}));
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const failures = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isElementAccessExpression(callee) &&
            (ts.isStringLiteral(callee.argumentExpression) ||
              ts.isNoSubstitutionTemplateLiteral(callee.argumentExpression))
          ? callee.argumentExpression.text
          : undefined;
      if (name === 'localeCompare') {
        // AST text excludes surrounding comments. Normalize only insignificant source whitespace.
        const expression = ts
          .createPrinter({ removeComments: true })
          .printNode(ts.EmitHint.Expression, node, file);
        const remaining = allowed.get(expression) ?? 0;
        if (remaining > 0) allowed.set(expression, remaining - 1);
        else
          failures.push(
            `${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: use compareCodeUnits; retained changes belong to #532`
          );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return failures;
}

/** Checks tracked production sources only; dynamic aliases are outside this bounded AST check. */
function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const paths = execFileSync('git', ['ls-files', '-z', 'apps/nanocore/src', 'packages'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(
      (path) =>
        /\.[cm]?[jt]sx?$/.test(path) &&
        path.includes('/src/') &&
        !/\.(test|spec)\.[^.]+$/.test(path) &&
        !path.includes('/test-support/')
    );
  const failures = paths.flatMap((path) =>
    unexpectedLocaleComparisons(path, readFileSync(resolve(root, path), 'utf8'))
  );
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else console.log('Locale ordering: PASS (no deferred comparisons)');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
