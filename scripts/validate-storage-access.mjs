#!/usr/bin/env node
/** Shrink-only direct-access census for the accepted storage foundation, sections 4 and 7.
 * Tracks static imports/require, local aliases, promises and handles; not inter-file exports,
 * runtime-generated member names, reassignment, native addons, shell commands or reflective calls.
 */
import { createHash } from 'node:crypto';
import { constants, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const sqliteOwner = 'apps/nanocore/src/storage/control-store-worker.ts';
const byteOwner = 'packages/storage/src/local.ts';
const excluded =
  /^(?:node_modules|dist|build|coverage|tests?|test-support|fixtures?|__tests__|__fixtures__|e2e)$/;
const writes =
  /^(?:write(?:File|v)?|appendFile|rename|createWriteStream|rm|rmdir|unlink|mkdir|copyFile|cp|truncate|ftruncate|chmod|fchmod|chown|fchown|lchown|lchmod|utimes|lutimes|futimes|link|symlink|mkdtemp|fsync|fdatasync)(?:Sync)?$/;
const printer = ts.createPrinter({ removeComments: true });
const moduleKind = (name) =>
  /^(?:node:)?fs(?:\/promises)?$/.test(name)
    ? 'fs'
    : name === 'better-sqlite3'
      ? 'sqlite'
      : name === 'node:sqlite'
        ? 'sqliteNamespace'
        : name === 'node:module'
          ? 'module'
          : undefined;
const literal = (node) => node && (ts.isStringLiteralLike(node) ? node.text : undefined);

/** Counts normalized physical-access expressions in one production source. */
export function storageAccessSites(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error(`Cannot parse storage access: ${path}`);
  const aliases = new Map();
  const variables = [];
  const sites = {};
  const member = (origin, name) =>
    origin === 'fs'
      ? name === 'promises'
        ? 'fs'
        : name === 'constants'
          ? 'flags'
          : `fs:${name}`
      : origin === 'flags'
        ? `flag:${name}`
        : origin === 'handle'
          ? `fs:${name}`
          : origin === 'sqliteNamespace' && name === 'DatabaseSync'
            ? 'sqlite'
            : origin === 'sqlite' && name === 'default'
              ? 'sqlite'
              : origin === 'module' && name === 'createRequire'
                ? 'requireFactory'
                : undefined;
  const origin = (node) => {
    if (!node) return undefined;
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node))
      return origin(node.expression);
    if (ts.isIdentifier(node))
      return aliases.get(node.text) ?? (node.text === 'require' ? 'require' : undefined);
    if (ts.isPropertyAccessExpression(node)) return member(origin(node.expression), node.name.text);
    if (ts.isElementAccessExpression(node))
      return member(origin(node.expression), literal(node.argumentExpression));
    if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        origin(node.expression) === 'require'
      )
        return moduleKind(literal(node.arguments[0]));
      if (origin(node.expression) === 'requireFactory') return 'require';
      if (/^fs:open(?:Sync)?$/.test(origin(node.expression) ?? '')) return 'handle';
    }
    return undefined;
  };
  const bind = (name, value) => {
    if (ts.isIdentifier(name) && value && !aliases.has(name.text)) {
      aliases.set(name.text, value);
      return true;
    }
    if (!ts.isObjectBindingPattern(name)) return false;
    let changed = false;
    for (const item of name.elements)
      changed =
        bind(item.name, member(value, item.propertyName?.text ?? item.name.text)) || changed;
    return changed;
  };
  const gather = (node) => {
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      bind(node.name, moduleKind(literal(node.moduleReference.expression)));
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const value = moduleKind(node.moduleSpecifier.text),
        clause = node.importClause;
      if (clause?.name) bind(clause.name, value);
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) bind(named.name, value);
      else
        for (const item of named?.elements ?? [])
          if (!item.isTypeOnly)
            bind(item.name, member(value, item.propertyName?.text ?? item.name.text));
    }
    if (ts.isVariableDeclaration(node)) variables.push(node);
    ts.forEachChild(node, gather);
  };
  gather(source);
  while (
    variables.reduce((changed, node) => bind(node.name, origin(node.initializer)) || changed, false)
  ) {}
  const flags = (node) => {
    if (!node) return 0;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarToken) {
      const left = flags(node.left),
        right = flags(node.right);
      return left === undefined || right === undefined ? undefined : left | right;
    }
    const name = origin(node);
    return name?.startsWith('flag:') ? constants[name.slice(5)] : undefined;
  };
  const writableOpen = (node) => {
    const value = literal(node);
    if (value !== undefined) return /[wa+]/.test(value) || !/^(?:r|rs|sr)$/.test(value);
    const valueFlags = flags(node);
    return (
      valueFlags === undefined ||
      (valueFlags &
        (constants.O_WRONLY |
          constants.O_RDWR |
          constants.O_CREAT |
          constants.O_TRUNC |
          constants.O_APPEND)) !==
        0
    );
  };
  const visit = (node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const value = origin(node.expression);
      const operation = value?.startsWith('fs:') ? value.slice(3) : '';
      const kind =
        value === 'sqlite' && path !== sqliteOwner
          ? 'sqlite'
          : path !== byteOwner &&
              (writes.test(operation) ||
                (/^open(?:Sync)?$/.test(operation) && writableOpen(node.arguments?.[1])))
            ? `fs:${operation}`
            : undefined;
      if (kind) {
        const expression = printer.printNode(ts.EmitHint.Expression, node, source).trim();
        const hash = createHash('sha256').update(expression).digest('hex');
        const key = `${path}\t${kind}\t${hash}`;
        sites[key] = (sites[key] ?? 0) + 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

/** Includes new/untracked source files; physical ownership exemptions are per operation above. */
export function scanStorageAccess(root) {
  const sites = {};
  const walk = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )) {
      const path = join(directory, item.name);
      if (item.isDirectory() && !excluded.test(item.name)) walk(path);
      if (
        !item.isFile() ||
        !/\.[cm]?[jt]sx?$/.test(item.name) ||
        /\.(?:test|spec)\.[^.]+$/.test(item.name)
      )
        continue;
      Object.assign(
        sites,
        storageAccessSites(relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8'))
      );
    }
  };
  for (const directory of ['apps', 'packages']) walk(join(root, directory));
  return Object.fromEntries(Object.entries(sites).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Refresh can remove allowances only; a failing growth check never writes the baseline. */
function main() {
  const args = process.argv.slice(2),
    refresh = args.includes('--refresh-shrink');
  const rootIndex = args.indexOf('--root');
  if (
    args.some(
      (arg, index) =>
        arg !== '--refresh-shrink' &&
        arg !== '--root' &&
        !(rootIndex >= 0 && index === rootIndex + 1)
    ) ||
    (rootIndex >= 0 && !args[rootIndex + 1])
  )
    throw new Error('Usage: validate-storage-access.mjs [--root PATH] [--refresh-shrink]');
  const root = resolve(
    rootIndex < 0 ? fileURLToPath(new URL('..', import.meta.url)) : args[rootIndex + 1]
  );
  const path = join(root, 'scripts/storage-access-baseline.json');
  const baseline = JSON.parse(readFileSync(path, 'utf8'));
  if (
    baseline.version !== 1 ||
    !baseline.sites ||
    Object.values(baseline.sites).some((n) => !Number.isSafeInteger(n) || n < 1)
  )
    throw new Error('Invalid storage-access baseline');
  const sites = scanStorageAccess(root);
  const growth = Object.entries(sites).filter(([key, count]) => count > (baseline.sites[key] ?? 0));
  if (growth.length)
    throw new Error(
      `New/increased direct storage access:\n${growth.map(([key, count]) => `${key}: ${baseline.sites[key] ?? 0} -> ${count}`).join('\n')}`
    );
  const next = `${JSON.stringify({ version: 1, sites }, null, 2)}\n`;
  if (refresh) writeFileSync(path, next);
  else if (JSON.stringify(sites) !== JSON.stringify(baseline.sites))
    throw new Error('Storage access shrank; run --refresh-shrink before landing.');
  console.log(
    `Storage access: PASS (${Object.values(sites).reduce((sum, count) => sum + count, 0)} remaining sites${refresh ? '; baseline shrunk' : ''})`
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
