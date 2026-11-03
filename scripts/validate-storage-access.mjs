#!/usr/bin/env node
/** Shrink-only storage-access census and closed module-domain interface ceilings.
 * The physical-site census tracks imports/require, local aliases, promises and handles; not inter-file exports,
 * runtime-generated member names, reassignment, native addons, shell commands or reflective calls.
 */
import { createHash } from 'node:crypto';
import { constants, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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

/** Shared production inventory, including new/untracked files. */
function productionFiles(root) {
  const files = [];
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
      files.push(path);
    }
  };
  for (const directory of ['apps', 'packages']) walk(join(root, directory));
  return files;
}

/** Includes new/untracked source files; physical ownership exemptions are per operation above. */
export function scanStorageAccess(root) {
  const sites = {};
  for (const path of productionFiles(root))
    Object.assign(
      sites,
      storageAccessSites(relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8'))
    );
  return Object.fromEntries(Object.entries(sites).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const closedDomains = ['artifacts', 'artifact-zip-snapshots'];
const artifactDirectory = 'apps/nanocore/src/storage/artifacts/';
const zipFiles = ['artifact-folder-cache.ts', 'zip-snapshot.ts'];
const domainOf = (path) => {
  if (zipFiles.some((name) => path === artifactDirectory + name)) return 'artifact-zip-snapshots';
  if (
    (path.startsWith(artifactDirectory) &&
      /^[^/]+\.ts$/.test(path.slice(artifactDirectory.length))) ||
    path === 'apps/nanocore/src/storage/schema/artifact-reviews.ts'
  )
    return 'artifacts';
  return undefined;
};

/** Module references that can create a production file-pair edge. */
function moduleReferences(source) {
  const references = [];
  const visit = (node) => {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      specifier = node.moduleSpecifier;
    else if (ts.isExternalModuleReference(node)) specifier = node.expression;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      specifier = node.argument.literal;
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      specifier = node.arguments[0];
    const name = literal(specifier);
    if (name !== undefined) references.push(name);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

/** Measures the two closed domains without executing product code or writing declarations. */
export function measureModuleDomains(root) {
  root = resolve(root);
  const files = productionFiles(root);
  const owned = new Map(
    files.map((file) => [file, domainOf(relative(root, file).split('\\').join('/'))])
  );
  const options = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    declaration: true,
    emitDeclarationOnly: true,
    skipLibCheck: true,
    strict: true,
    allowJs: true,
  };
  const host = ts.createCompilerHost(options);
  const resolveRelative = (name, file) =>
    name.startsWith('.')
      ? ts.resolveModuleName(name, file, options, host).resolvedModule
      : undefined;
  const domainFiles = files.filter((file) => owned.get(file));
  const program = ts.createProgram(domainFiles, options, host);
  const checker = program.getTypeChecker();
  const measured = Object.fromEntries(
    closedDomains.map((domain) => [
      domain,
      { exports: 0, crossDirectoryImports: 0, externalImporters: 0 },
    ])
  );
  const targetOf = (symbol) =>
    checker.getExportSymbolOfSymbol(
      symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    );
  const exportsByFile = new Map(
    domainFiles.map((file) => {
      const source = program.getSourceFile(file);
      if (source.parseDiagnostics.length) throw new Error(`Cannot parse module domain: ${file}`);
      return [file, source.symbol ? checker.getExportsOfModule(source.symbol) : []];
    })
  );
  const exported = new Set([...exportsByFile.values()].flat().map(targetOf));
  const privateTypes = new Set();
  const retain = (symbol) => {
    if (!symbol) return;
    symbol = targetOf(symbol);
    if (
      !exported.has(symbol) &&
      symbol.declarations?.some(
        (node) =>
          owned.get(node.getSourceFile().fileName) &&
          !(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) &&
          (ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isEnumDeclaration(node) ||
            ts.isClassDeclaration(node))
      )
    )
      privateTypes.add(symbol);
  };
  for (const file of domainFiles) {
    const source = program.getSourceFile(file);
    const exports = exportsByFile.get(file);
    measured[owned.get(file)].exports += exports.length;
    const checked = new Set();
    // Follow only signature types and inference inputs. An unresolved import used solely
    // for a body effect must not fail a sound signature; an inferred any must not hide it.
    const checkSignature = (node) => {
      if (!node || checked.has(node) || !owned.get(node.getSourceFile().fileName)) return;
      checked.add(node);
      if (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Private) return;
      if (ts.isIdentifier(node)) {
        for (const declaration of checker.getSymbolAtLocation(node)?.declarations ?? [])
          if (owned.get(declaration.getSourceFile().fileName)) checkSignature(declaration);
        return;
      }
      let importNode = node;
      while (
        importNode &&
        !ts.isSourceFile(importNode) &&
        !ts.isImportDeclaration(importNode) &&
        !ts.isImportEqualsDeclaration(importNode)
      )
        importNode = importNode.parent;
      const names = importNode && !ts.isSourceFile(importNode) ? moduleReferences(importNode) : [];
      if (ts.isImportTypeNode(node)) names.push(...moduleReferences(node));
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const name = literal(node.arguments[0]);
        if (name !== undefined) names.push(name);
      }
      for (const name of names)
        if (name.startsWith('.') && !resolveRelative(name, node.getSourceFile().fileName))
          throw new Error(`Unresolvable relative import in exported signature: ${file}: ${name}`);
      if (ts.isFunctionLike(node)) {
        for (const parameter of node.parameters)
          checkSignature(parameter.type ?? parameter.initializer);
        for (const parameter of node.typeParameters ?? []) checkSignature(parameter);
        if (node.type) checkSignature(node.type);
        else if (node.body && ts.isBlock(node.body)) {
          const returns = (child) => {
            if (ts.isReturnStatement(child)) checkSignature(child.expression);
            else if (!ts.isFunctionLike(child)) ts.forEachChild(child, returns);
          };
          returns(node.body);
        } else checkSignature(node.body);
        return;
      }
      if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
        checkSignature(node.type ?? node.initializer);
        return;
      }
      if (ts.isModuleDeclaration(node)) {
        const symbol = checker.getSymbolAtLocation(node.name);
        for (const member of symbol ? checker.getExportsOfModule(symbol) : [])
          for (const declaration of targetOf(member).declarations ?? [])
            checkSignature(declaration);
        return;
      }
      if (!ts.isBlock(node)) ts.forEachChild(node, checkSignature);
    };
    const seen = new Set();
    // The checker also preserves locally declared types in inferred returns, which the
    // declaration printer can spell as anonymous objects. Do not inspect function bodies.
    const visitType = (type) => {
      if (!type || seen.has(type)) return;
      seen.add(type);
      retain(type.aliasSymbol);
      retain(type.symbol);
      for (const part of type.types ?? []) visitType(part);
      for (const part of type.aliasTypeArguments ?? []) visitType(part);
      if (type.flags & ts.TypeFlags.TypeParameter) visitType(checker.getBaseConstraintOfType(type));
      if (!(type.flags & ts.TypeFlags.Object)) return;
      if (type.objectFlags & ts.ObjectFlags.Reference)
        for (const argument of checker.getTypeArguments(type)) visitType(argument);
      // External library internals cannot add a named declaration in a closed domain.
      if (type.symbol?.declarations?.every((node) => !owned.get(node.getSourceFile().fileName)))
        return;
      for (const property of type.getProperties()) {
        if (
          property.declarations?.some(
            (node) =>
              ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Private ||
              (node.name && ts.isPrivateIdentifier(node.name))
          )
        )
          continue;
        visitType(checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? source));
      }
      for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
        for (const parameter of signature.parameters)
          visitType(
            checker.getTypeOfSymbolAtLocation(parameter, parameter.valueDeclaration ?? source)
          );
        for (const parameter of signature.typeParameters ?? []) visitType(parameter);
        visitType(checker.getReturnTypeOfSignature(signature));
      }
      for (const index of checker.getIndexInfosOfType(type)) {
        visitType(index.keyType);
        visitType(index.type);
      }
    };
    for (const symbol of exports) {
      const target = targetOf(symbol);
      for (const declaration of target.declarations ?? []) checkSignature(declaration);
      if (target.flags & ts.SymbolFlags.Type) visitType(checker.getDeclaredTypeOfSymbol(target));
      if (target.flags & ts.SymbolFlags.Value)
        visitType(checker.getTypeOfSymbolAtLocation(target, source));
    }
    // Emission retains aliases that the checker can reduce to primitives. Original nodes
    // identify declarations even within namespaces or when a local name is shadowed.
    const result = program.emit(
      source,
      (_path, text) => {
        const declaration = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        for (const name of moduleReferences(declaration))
          if (name.startsWith('.') && !resolveRelative(name, file))
            throw new Error(`Unresolvable relative import in exported signature: ${file}: ${name}`);
      },
      undefined,
      true,
      {
        afterDeclarations: [
          () => (declaration) => {
            const visit = (node) => {
              if (
                exports.length &&
                node.name &&
                (ts.isInterfaceDeclaration(node) ||
                  ts.isTypeAliasDeclaration(node) ||
                  ts.isEnumDeclaration(node) ||
                  ts.isClassDeclaration(node))
              )
                retain(checker.getSymbolAtLocation(ts.getOriginalNode(node).name));
              ts.forEachChild(node, visit);
            };
            visit(declaration);
            return declaration;
          },
        ],
      }
    );
    if (
      result.emitSkipped ||
      result.diagnostics.some((item) => item.category === ts.DiagnosticCategory.Error)
    )
      throw new Error(
        `Cannot measure exported signatures: ${file}: ${ts.formatDiagnostics(result.diagnostics, host)}`
      );
  }
  for (const symbol of privateTypes) {
    const domain = symbol.declarations
      .map((node) => owned.get(node.getSourceFile().fileName))
      .find(Boolean);
    measured[domain].exports++;
  }
  const external = Object.fromEntries(closedDomains.map((domain) => [domain, new Set()]));
  for (const file of files) {
    const source =
      program.getSourceFile(file) ??
      ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const targets = new Set(
      moduleReferences(source).map((name) => resolveRelative(name, file)?.resolvedFileName)
    );
    for (const target of targets) {
      const domain = owned.get(target);
      if (!domain) continue;
      if (dirname(file) !== dirname(target)) measured[domain].crossDirectoryImports++;
      if (owned.get(file) !== domain) external[domain].add(file);
    }
  }
  for (const domain of closedDomains) measured[domain].externalImporters = external[domain].size;
  return measured;
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
  const exactKeys = (value, keys) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
  if (
    !exactKeys(baseline, ['version', 'sites', 'moduleDomains']) ||
    baseline.version !== 2 ||
    baseline.sites === null ||
    typeof baseline.sites !== 'object' ||
    Array.isArray(baseline.sites) ||
    Object.values(baseline.sites).some((n) => !Number.isSafeInteger(n) || n < 1) ||
    !exactKeys(baseline.moduleDomains, closedDomains) ||
    closedDomains.some(
      (domain) =>
        !exactKeys(baseline.moduleDomains[domain], ['exports', 'crossDirectoryImports']) ||
        Object.values(baseline.moduleDomains[domain]).some((n) => !Number.isSafeInteger(n) || n < 0)
    )
  )
    throw new Error(
      'Invalid storage-access baseline (version 2 with all closed moduleDomains required)'
    );
  const sites = scanStorageAccess(root);
  const measured = measureModuleDomains(root);
  const moduleDomains = {};
  const domainGrowth = [];
  for (const domain of closedDomains) {
    const { exports, crossDirectoryImports, externalImporters } = measured[domain];
    console.log(`${domain}: E=${exports} I=${crossDirectoryImports} F=${externalImporters}`);
    moduleDomains[domain] = { exports, crossDirectoryImports };
    for (const metric of ['exports', 'crossDirectoryImports'])
      if (measured[domain][metric] > baseline.moduleDomains[domain][metric])
        domainGrowth.push(
          `${domain}.${metric}: ${baseline.moduleDomains[domain][metric]} -> ${measured[domain][metric]}`
        );
  }
  const growth = Object.entries(sites).filter(([key, count]) => count > (baseline.sites[key] ?? 0));
  if (growth.length || domainGrowth.length)
    throw new Error(
      `New/increased storage access or module interface:\n${[
        ...growth.map(([key, count]) => `${key}: ${baseline.sites[key] ?? 0} -> ${count}`),
        ...domainGrowth,
      ].join('\n')}`
    );
  const next = `${JSON.stringify({ version: 2, sites, moduleDomains }, null, 2)}\n`;
  if (refresh) {
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, next, { flag: 'wx' });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  } else if (
    Object.entries(baseline.sites).some(([key, count]) => count > (sites[key] ?? 0)) ||
    closedDomains.some((domain) =>
      Object.keys(moduleDomains[domain]).some(
        (metric) => baseline.moduleDomains[domain][metric] > moduleDomains[domain][metric]
      )
    )
  )
    throw new Error(
      'Storage access or module interface shrank; run --refresh-shrink before landing.'
    );
  console.log(
    `Storage access: PASS (${Object.values(sites).reduce((sum, count) => sum + count, 0)} remaining sites${refresh ? '; baseline shrunk' : ''})`
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
