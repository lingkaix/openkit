#!/usr/bin/env node
/** Blocks new locale-dependent machine ordering; #532 END and BR leases stay explicit. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// #532: exact original expressions only. Remove entries when END or BR retires their callers.
// BEGIN DEFERRED COMPARISONS
const deferredComparisons = {
  'apps/nanocore/src/audit-events.ts': {
    "(left.createdAt ?? '').localeCompare(right.createdAt ?? '')": 1,
    'left.id.localeCompare(right.id)': 1,
  },
  'apps/nanocore/src/context/worker-context-package.ts': {
    'a.packagePath.localeCompare(b.packagePath)': 2,
    'left.path.localeCompare(right.path)': 5,
    'a.path.localeCompare(b.path)': 1,
    'left.itemId.localeCompare(right.itemId)': 2,
    'left.localeCompare(right)': 2,
    'left.materialId.localeCompare(right.materialId)': 1,
    'left.revisionId.localeCompare(right.revisionId)': 1,
  },
  'apps/nanocore/src/internal-agents/internal-context-evidence.ts': {
    "(left.trace.queryContext.turnId ?? '').localeCompare(right.trace.queryContext.turnId ?? '')": 1,
    'left.reference.objectId.localeCompare(right.reference.objectId)': 1,
  },
  'apps/nanocore/src/internal-agents/rolling-context.ts': {
    "(left.startedAt ?? '').localeCompare(right.startedAt ?? '')": 1,
    'right.createdAt.localeCompare(left.createdAt)': 1,
  },
  'apps/nanocore/src/knowledge/knowledge-agent-maintenance.ts': {
    "(left.completedAt ?? '').localeCompare(right.completedAt ?? '')": 1,
  },
  'apps/nanocore/src/lib/automation-store.ts': {
    'a.schedule.id.localeCompare(b.schedule.id)': 1,
  },
  'apps/nanocore/src/lib/store.ts': {
    "(a.startedAt ?? '').localeCompare(b.startedAt ?? '')": 1,
  },
  'apps/nanocore/src/policy/statements.ts': {
    'a.id.localeCompare(b.id)': 1,
  },
  'apps/nanocore/src/runtime/agent-environment.ts': {
    'left.localeCompare(right)': 1,
  },
  'apps/nanocore/src/runtime/filesystem-workspace-sync.ts': {
    'left.path.localeCompare(right.path)': 1,
  },
  'apps/nanocore/src/runtime/nanohost-effect-identity.ts': {
    'left.localeCompare(right)': 1,
  },
  'apps/nanocore/src/runtime/nanohost-harness-records.ts': {
    'left.localeCompare(right)': 1,
  },
  'apps/nanocore/src/runtime/worker-governance-backend.ts': {
    'left.relativePath.localeCompare(right.relativePath)': 1,
    'left.id.localeCompare(right.id)': 1,
    'left.path.localeCompare(right.path)': 2,
  },
  'apps/nanocore/src/runtime/worker-storage-bindings.ts': {
    'left.target.localeCompare(right.target)': 3,
  },
  'apps/nanocore/src/storage/command-request-records.ts': {
    'left.localeCompare(right)': 1,
  },
  'apps/nanocore/src/storage/control-store-input.ts': {
    'left.localeCompare(right)': 1,
  },
  'apps/nanocore/src/storage/data-root-backup.ts': {
    'left.path.localeCompare(right.path)': 1,
  },
  'apps/nanocore/src/storage/workspace-export.ts': {
    'left.path.localeCompare(right.path)': 1,
    'recordSortKey(left).localeCompare(recordSortKey(right))': 1,
  },
  'apps/nanocore/src/storage/workspace-import.ts': {
    'left.localeCompare(right)': 1,
  },
  'apps/nanocore/src/storage/workspace-restore.ts': {
    'a.sourceAccountId.localeCompare(b.sourceAccountId)': 1,
    'a.targetAccountId.localeCompare(b.targetAccountId)': 1,
  },
  'apps/nanocore/src/storage/workspace-storage-migration.ts': {
    'left.workspaceId.localeCompare(right.workspaceId)': 1,
  },
  'apps/nanocore/src/storage/workspace-transfer-routes.ts': {
    "(left.startedAt ?? '').localeCompare(right.startedAt ?? '')": 1,
  },
  'apps/nanocore/src/worker-environments/worker-environment-activation.ts': {
    'left.storageRef.localeCompare(right.storageRef)': 2,
  },
  'apps/nanocore/src/worker-environments/worker-environment-preparation.ts': {
    'left.localeCompare(right)': 1,
    'left.storageRef.localeCompare(right.storageRef)': 1,
  },
  'apps/nanocore/src/workspace-deletion-evidence.ts': {
    'left.path.localeCompare(right.path)': 2,
    '`${left.category}:${left.unit}`.localeCompare(`${right.category}:${right.unit}`)': 1,
  },
  'packages/app-api-schemas/src/worker-environment.ts': {
    'left.storageRef.localeCompare(right.storageRef)': 1,
  },
  'packages/config-schema/src/session-workspace.ts': {
    'left.localeCompare(right)': 1,
  },
  'packages/config-schema/src/source-catalog.ts': {
    'left.localeCompare(right)': 1,
  },
  'packages/worker-shim/src/codex-runtime-provenance.ts': {
    'left.localeCompare(right)': 2,
    "(state.paths[index] ?? '').localeCompare(state.paths[largestIndex] ?? '')": 1,
    "path.localeCompare(state.paths[largestIndex] ?? '')": 1,
  },
};
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
            `${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: use compareCodeUnits; retained changes belong to #532 END`
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
  } else console.log('Locale ordering: PASS (named #532 END/BR comparisons deferred)');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
