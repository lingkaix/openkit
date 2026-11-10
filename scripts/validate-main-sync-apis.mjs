#!/usr/bin/env node
/** Shrink-only native synchronous API census for NanoCore's runtime module graph.
 * This bounded AST check follows literal imports and local aliases, not dynamic code,
 * external dependencies, inter-file alias exports or calls to existing sync wrappers.
 * A Worker URL is not a Main import; a module also imported on Main is still inspected.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript6';

const entrypoint = 'apps/nanocore/src/index.ts';
const printer = ts.createPrinter({ removeComments: true });
const literal = (node) => (node && ts.isStringLiteralLike(node) ? node.text : undefined);
const moduleKind = (name) =>
  /^(?:node:)?fs$/.test(name)
    ? 'fs'
    : /^(?:node:)?child_process$/.test(name)
      ? 'child_process'
      : /^(?:node:)?(?:crypto|zlib)$/.test(name)
        ? name.replace(/^node:/, '')
        : name === 'node:sqlite'
          ? 'sqlite'
          : name === 'better-sqlite3'
            ? 'sqlite:constructor'
            : name === 'node:module'
              ? 'module'
              : undefined;
const member = (origin, name) =>
  ['fs', 'child_process', 'crypto', 'zlib'].includes(origin)
    ? `${origin}:${name}`
    : origin === 'atomics' && name === 'wait'
      ? 'atomics:wait'
      : origin === 'sqlite' && name === 'DatabaseSync'
        ? 'sqlite:constructor'
        : origin === 'module' && name === 'createRequire'
          ? 'requireFactory'
          : origin === 'sqlite:constructor' && name === 'default'
            ? origin
            : undefined;

/** Parses actual source, refusing a partial census on syntax errors. */
function parse(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw Error(`Cannot parse Main source: ${path}`);
  return source;
}

/** Resolves native imports and local aliases without executing any production source. */
function aliasesOf(source) {
  const aliases = new Map(),
    variables = [];
  const origin = (node) => {
    if (!node) return undefined;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isAwaitExpression(node))
      return origin(node.expression);
    if (ts.isIdentifier(node))
      return (
        aliases.get(node.text) ??
        (node.text === 'require' ? 'require' : node.text === 'Atomics' ? 'atomics' : undefined)
      );
    if (ts.isPropertyAccessExpression(node)) return member(origin(node.expression), node.name.text);
    if (ts.isElementAccessExpression(node))
      return member(origin(node.expression), literal(node.argumentExpression));
    if (ts.isCallExpression(node)) {
      if (
        origin(node.expression) === 'require' ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      )
        return moduleKind(literal(node.arguments[0]));
      if (origin(node.expression) === 'requireFactory') return 'require';
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
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const value = moduleKind(literal(node.moduleSpecifier)),
        clause = node.importClause;
      if (clause?.name) bind(clause.name, value);
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) bind(named.name, value);
      else
        for (const item of named?.elements ?? [])
          if (!item.isTypeOnly)
            bind(item.name, member(value, item.propertyName?.text ?? item.name.text));
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      bind(node.name, moduleKind(literal(node.moduleReference.expression)));
    if (ts.isVariableDeclaration(node)) variables.push(node);
    ts.forEachChild(node, gather);
  };
  gather(source);
  while (
    variables.reduce((changed, node) => bind(node.name, origin(node.initializer)) || changed, false)
  ) {}
  return origin;
}

/** Counts normalized exact call expressions, including duplicate occurrences. */
export function mainSyncApiSites(path, text) {
  const source = parse(path, text),
    origin = aliasesOf(source),
    sites = {};
  const visit = (node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const kind = origin(node.expression);
      if (
        kind === 'sqlite:constructor' ||
        kind === 'atomics:wait' ||
        /^(?:fs|crypto|zlib):.*Sync$/.test(kind ?? '') ||
        /^child_process:(?:execSync|execFileSync|spawnSync)$/.test(kind ?? '')
      ) {
        const expression = printer.printNode(ts.EmitHint.Expression, node, source).trim();
        const key = `${path}\t${kind}\t${createHash('sha256').update(expression).digest('hex')}`;
        sites[key] = (sites[key] ?? 0) + 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

/** Collects only runtime edges, including literal dynamic imports and createRequire aliases. */
function runtimeReferences(source) {
  const refs = [],
    origin = aliasesOf(source);
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause,
        named = clause?.namedBindings;
      if (
        !clause?.isTypeOnly &&
        (!clause ||
          clause.name ||
          !named ||
          ts.isNamespaceImport(named) ||
          named.elements.length === 0 ||
          named.elements.some((e) => !e.isTypeOnly))
      )
        refs.push(literal(node.moduleSpecifier));
    } else if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      if (
        !node.isTypeOnly &&
        (!clause ||
          !ts.isNamedExports(clause) ||
          clause.elements.length === 0 ||
          clause.elements.some((e) => !e.isTypeOnly))
      )
        refs.push(literal(node.moduleSpecifier));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      refs.push(literal(node.moduleReference.expression));
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        origin(node.expression) === 'require')
    )
      refs.push(literal(node.arguments[0]));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return refs.filter((r) => r !== undefined);
}

/** Maps declared workspace runtime exports back to their source owners. */
function workspacePackages(root) {
  const packages = new Map(),
    directory = join(root, 'packages');
  if (!existsSync(directory)) return packages;
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name),
      manifest = join(path, 'package.json');
    if (item.isDirectory() && existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      packages.set(pkg.name, { path, pkg });
    }
  }
  return packages;
}
const runtimeExport = (value) =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.map(runtimeExport).find(Boolean)
      : value && typeof value === 'object'
        ? runtimeExport(value.import ?? value.node ?? value.default)
        : undefined;

/** Follows literal Main imports, including new/untracked production modules. */
export function scanMainSyncApis(root) {
  root = resolve(root);
  const packages = workspacePackages(root),
    seen = new Set(),
    sites = {};
  const resolveSource = (path) => {
    const stem = path.replace(/\.[cm]?js$/, '');
    return [
      `${stem}.ts`,
      `${stem}.mts`,
      `${stem}.cts`,
      `${stem}.tsx`,
      path,
      join(path, 'index.ts'),
      join(path, 'index.js'),
    ].find((p) => existsSync(p) && /\.[cm]?[jt]sx?$/.test(p) && !p.endsWith('.d.ts'));
  };
  const target = (from, name) => {
    if (name.startsWith('.')) {
      if (/\.(?:json|node|wasm)$/.test(name)) return undefined;
      const path = resolveSource(resolve(dirname(from), name));
      if (!path) throw Error(`Unresolved Main import: ${relative(root, from)} -> ${name}`);
      return path;
    }
    const parts = name.split('/'),
      packageName = name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0],
      owner = packages.get(packageName);
    if (!owner) return undefined;
    const subpath = `.${name.slice(packageName.length) || ''}`;
    const declaration = owner.pkg.exports;
    let selected = declaration?.[subpath] ?? (subpath === '.' ? declaration : undefined);
    let wildcard;
    if (!selected && declaration && typeof declaration === 'object')
      for (const [key, value] of Object.entries(declaration)) {
        const [prefix, suffix] = key.split('*');
        if (suffix !== undefined && subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
          selected = value;
          wildcard = subpath.slice(prefix.length, subpath.length - suffix.length);
          break;
        }
      }
    const exported = runtimeExport(selected)?.replace('*', wildcard ?? '*');
    if (exported && /\.(?:json|node|wasm)$/.test(exported)) {
      if (!existsSync(resolve(owner.path, exported)))
        throw Error(`Missing Main data export: ${name}`);
      return undefined;
    }
    const path =
      exported && resolveSource(resolve(owner.path, exported.replace(/^\.\/dist\//, './src/')));
    if (!path) throw Error(`Unresolved Main workspace export: ${name}`);
    return path;
  };
  const walk = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const text = readFileSync(path, 'utf8'),
      name = relative(root, path).split('\\').join('/');
    Object.assign(sites, mainSyncApiSites(name, text));
    for (const name of runtimeReferences(parse(path, text))) {
      const next = target(path, name);
      if (next) walk(next);
    }
  };
  walk(join(root, entrypoint));
  return {
    modules: [...seen].map((p) => relative(root, p).split('\\').join('/')).sort(),
    sites: Object.fromEntries(
      Object.entries(sites).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    ),
  };
}

/** New expressions and count increases fail; removed allowances must be shrunk explicitly. */
export function compareSyncApiAllowance(actual, allowed, { shrink = false } = {}) {
  const failures = [];
  for (const [key, count] of Object.entries(actual))
    if (count > (allowed[key] ?? 0))
      failures.push(`New Main sync API: ${key} (${count} > ${allowed[key] ?? 0})`);
  if (!shrink)
    for (const [key, count] of Object.entries(allowed))
      if ((actual[key] ?? 0) < count) failures.push(`Remove stale Main sync allowance: ${key}`);
  return failures;
}

/** Refresh removes allowances only; no option can initialize or grow the inventory. */
function main() {
  const args = process.argv.slice(2),
    shrink = args.includes('--refresh-shrink');
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
    throw Error('Usage: validate-main-sync-apis.mjs [--root PATH] [--refresh-shrink]');
  const root = resolve(
    rootIndex < 0 ? fileURLToPath(new URL('..', import.meta.url)) : args[rootIndex + 1]
  );
  const path = join(root, 'scripts/main-sync-api-allowlist.json');
  const allowance = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !allowance ||
    typeof allowance !== 'object' ||
    Array.isArray(allowance) ||
    Object.keys(allowance).sort().join(',') !== 'entrypoint,schemaVersion,sites' ||
    allowance.schemaVersion !== 1 ||
    allowance.entrypoint !== entrypoint ||
    !allowance.sites ||
    typeof allowance.sites !== 'object' ||
    Array.isArray(allowance.sites) ||
    Object.values(allowance.sites).some((n) => !Number.isSafeInteger(n) || n < 1)
  )
    throw Error('Invalid Main sync API allowance');
  const scan = scanMainSyncApis(root),
    failures = compareSyncApiAllowance(scan.sites, allowance.sites, { shrink });
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
    return;
  }
  if (shrink)
    writeFileSync(path, `${JSON.stringify({ ...allowance, sites: scan.sites }, null, 2)}\n`);
  console.log(
    `Main sync APIs: PASS (${scan.modules.length} runtime modules, ${Object.values(scan.sites).reduce((a, b) => a + b, 0)} retained sites; shrink only)`
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
