#!/usr/bin/env node
/**
 * Static test-governance checks and one TAP skip assertion for repository tests.
 *
 * The platform-interface rule is a bounded enumeration of named surfaces. It cannot catch platform dependence that uses other interfaces, and it does not claim completeness of that residual.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const IGNORED_DIRECTORIES = new Set(['.git', '.turbo', 'coverage', 'dist', 'node_modules', 'temp']);
const CHILD_PROCESS_CALLEES = new Set([
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'fork',
  'spawn',
  'spawnSync',
]);
const CONTAINER_RUNTIMES = new Set(['docker', 'nerdctl', 'podman']);
const LINK_RESOLUTION_CALLEES = new Set([
  'readlink',
  'readlinkSync',
  'realpath',
  'realpathSync',
  'symlink',
  'symlinkSync',
]);
const PLATFORM_PATH_CALLEES = new Set([
  'access',
  'accessSync',
  'existsSync',
  'lstat',
  'lstatSync',
  'readFile',
  'readFileSync',
  'readdir',
  'readdirSync',
  'readlink',
  'readlinkSync',
  'stat',
  'statSync',
]);
const CONTAINER_SUBJECT_PRAGMA = '// openkit-test-container-subject';
const PLATFORM_POSIX_PRAGMA = '// openkit-test-platform: posix';
const PLATFORM_DIVERGENCE_PRAGMA = '// openkit-test-platform-divergence';
const HOST_PLACEMENT_PREFIX = /^bash\s+scripts\/test-env\.sh\s+host\b/u;
const OPENKIT_ENV_NAME = /^OPENKIT_[A-Z0-9_]+$/u;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]+=[^\s;|&<>]*$/u;
const SHELL_CALLEES = new Set(['exec', 'execSync']);
const VITEST_SKIP_SUMMARY = /^\s*(?:Test Files|Tests)\s+(\d+)\s+skipped\b/gimu;
const PRE_RUN_BINARY_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

/**
 * Validates static test-governance rules for one repository tree.
 *
 * Container-runtime and platform-interface findings are bounded syntactic conversions. Dockerfile text reads are allowed. The platform families do not cover dependence expressed through other interfaces.
 *
 * @param {string} root Repository or fixture root.
 * @returns {string[]} Stable file and line findings.
 */
export function validateTestGovernance(root) {
  const errors = [];
  const resolvedRoot = resolve(root);
  const hostMappedPaths = hostMappedTestPaths(resolvedRoot);
  for (const path of testFiles(resolvedRoot)) {
    const text = readFileSync(path, 'utf8');
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const containerSubject = containerSubjectPragmaHolds(text, hostMappedPaths, resolvedRoot, path);
    const platformFilePragma =
      hasExactPragma(text, PLATFORM_POSIX_PRAGMA) ||
      hasExactPragma(text, PLATFORM_DIVERGENCE_PRAGMA);
    const osBindings = nodeOsBindings(source);
    visit(source, (node) => {
      collectSkipFinding(errors, path, source, node);
      if (!containerSubject) {
        const runtime = containerRuntimeInvocation(node);
        if (runtime) {
          errors.push(finding(path, source, node, `test invokes container runtime ${runtime}`));
        }
      }
      if (!platformFilePragma && !platformPredicateCovers(node)) {
        const family = platformInterfaceFamily(node, osBindings);
        if (family) errors.push(finding(path, source, node, family));
      }
    });
  }
  return errors;
}

/** Runs one test command exactly once and returns runner-governance failures. */
export function runTestSuite(options) {
  return executeTestSuite(options).errors;
}

/** Executes one command and retains its output for the CLI projection. */
function executeTestSuite(options) {
  const command = options.command ?? [];
  if (!Array.isArray(command) || command.length === 0) {
    return { errors: ['A test command is required.'], stderr: '', stdout: '' };
  }
  const result = spawnSync(command[0], command.slice(1), {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    env: options.env ?? process.env,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const errors = [];
  if (result.error) errors.push(`Test command failed to start: ${result.error.message}`);
  if (result.signal) errors.push(`Test command ended from signal ${result.signal}.`);
  if (result.status !== null && result.status !== 0) {
    errors.push(`Test command exited with status ${result.status}.`);
  }
  const cwd = options.cwd ?? process.cwd();
  const declarations = options.allowedSkipDeclarations ?? declaredSkipNames(cwd);
  const discoveredTestFiles = options.discoveredTestFiles ?? relativeTestFiles(cwd);
  const output = `${stdout}\n${stderr}`;
  for (const name of reportedTapSkipNames(output)) {
    if (!fileBoundSkipIsAllowed(hierarchyParts(name), declarations, discoveredTestFiles)) {
      errors.push(`Test suite reported undeclared skip: ${name}`);
    }
  }
  const vitestSkipped = vitestSkippedCount(output);
  if (vitestSkipped > 0) {
    errors.push(
      `Test suite reported ${vitestSkipped} skipped test(s) that cannot be attributed to a declared pre-run opt-in`
    );
  }
  return { errors, stderr, stdout };
}

/** Returns test files beneath one repository root without following generated dependency trees. */
function testFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(resolve(directory, entry.name));
      } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
        files.push(resolve(directory, entry.name));
      }
    }
  }
  return files.sort();
}

/** Visits every syntax node in source order. */
function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

/** Returns the property name invoked by one call expression. */
function callMember(node) {
  return ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
}

/** Finds the nearest ancestor matching one TypeScript predicate. */
function ancestor(node, predicate) {
  let current = node.parent;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return null;
}

/** Collects one anti-skip finding for a skip, skipIf, or runIf call. */
function collectSkipFinding(errors, path, source, node) {
  if (!ts.isCallExpression(node)) return;
  const member = callMember(node);
  if (member !== 'skip' && member !== 'skipIf' && member !== 'runIf') return;
  if (member === 'skipIf' || member === 'runIf') {
    const condition = node.arguments[0];
    if (!condition || !isDeclaredPreRunCondition(condition)) {
      errors.push(
        finding(
          path,
          source,
          node,
          `${member} requires a pre-run platform or OPENKIT_* opt-in declaration`
        )
      );
    }
    return;
  }
  const catchClause = ancestor(node, ts.isCatchClause);
  if (catchClause) {
    errors.push(finding(path, source, node, 'skip is reachable from a caught runtime error'));
    return;
  }
  let guarded = false;
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isIfStatement(current)) continue;
    guarded = true;
    if (!isDeclaredPreRunCondition(current.expression)) {
      errors.push(
        finding(path, source, node, 'skip is conditioned on a runtime result or capability probe')
      );
      return;
    }
  }
  if (guarded) return;
  errors.push(finding(path, source, node, 'skip lacks a declared pre-run opt-in'));
}

/** Recognizes a pre-run condition composed only of bounded inputs, literals, and operators. */
function isDeclaredPreRunCondition(node) {
  return isPreRunExpressionShape(node) && containsBoundedPreRunInput(node);
}

/** Returns whether one expression uses only bounded pre-run inputs, literals, and operators. */
function isPreRunExpressionShape(node) {
  if (!node) return false;
  if (ts.isParenthesizedExpression(node)) return isPreRunExpressionShape(node.expression);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return isPreRunExpressionShape(node.operand);
  }
  if (ts.isBinaryExpression(node)) {
    return (
      PRE_RUN_BINARY_OPERATORS.has(node.operatorToken.kind) &&
      isPreRunExpressionShape(node.left) &&
      isPreRunExpressionShape(node.right)
    );
  }
  if (isPreRunLiteral(node)) return true;
  if (isProcessProperty(node, 'platform')) return true;
  return isOpenkitEnvAccess(node);
}

/** Returns whether one expression names process.platform or process.env.OPENKIT_*. */
function containsBoundedPreRunInput(node) {
  let found = false;
  visit(node, (child) => {
    if (isProcessProperty(child, 'platform') || isOpenkitEnvAccess(child)) found = true;
  });
  return found;
}

/** Returns whether one node is a literal permitted in a pre-run predicate. */
function isPreRunLiteral(node) {
  return (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined')
  );
}

/** Returns whether one node is `process.env.OPENKIT_*` or `process.env['OPENKIT_*']`. */
function isOpenkitEnvAccess(node) {
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'process' &&
    node.expression.name.text === 'env' &&
    OPENKIT_ENV_NAME.test(node.name.text)
  ) {
    return true;
  }
  return (
    ts.isElementAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'process' &&
    node.expression.name.text === 'env' &&
    node.argumentExpression !== undefined &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    OPENKIT_ENV_NAME.test(node.argumentExpression.text)
  );
}

/** Returns whether one source file contains an exact one-line pragma. */
function hasExactPragma(text, pragma) {
  return text.split(/\r?\n/u).includes(pragma);
}

/** Collects test paths named in arguments of an anchored `bash scripts/test-env.sh host` script. */
function hostMappedTestPaths(root) {
  const manifestPath = join(root, 'package.json');
  if (!existsSync(manifestPath)) return new Set();
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return new Set();
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest))
    return new Set();
  const paths = new Set();
  for (const command of Object.values(manifest.scripts ?? {})) {
    if (typeof command !== 'string' || !HOST_PLACEMENT_PREFIX.test(command)) continue;
    const argumentText = command.replace(HOST_PLACEMENT_PREFIX, '');
    const hostArguments = argumentText.split(/\s*(?:&&|\|\||;|&|\|)\s*/u)[0] ?? '';
    for (const token of hostArguments.split(/\s+/u)) {
      const mapped = token.replace(/^\.\//u, '');
      if (TEST_FILE.test(mapped)) paths.add(mapped.split('\\').join('/'));
    }
  }
  return paths;
}

/** Returns whether exact container-subject pragma is backed by a host-placed root script naming this file. */
function containerSubjectPragmaHolds(text, hostMappedPaths, root, path) {
  if (!hasExactPragma(text, CONTAINER_SUBJECT_PRAGMA)) return false;
  const relativePath = relative(root, path).split('\\').join('/');
  return hostMappedPaths.has(relativePath);
}

/** Counts skipped tests reported by a Vitest default-reporter summary that does not name them. */
function vitestSkippedCount(output) {
  let skipped = 0;
  for (const match of output.matchAll(VITEST_SKIP_SUMMARY)) {
    skipped = Math.max(skipped, Number(match[1] ?? 0));
  }
  return skipped;
}

/** Reads TAP and Turbo-prefixed tap-flat skip titles from one suite's combined output. */
function reportedTapSkipNames(output) {
  const names = [];
  for (const line of output.split(/\r?\n/u)) {
    const stripped = line.replace(/^(?:[^:\s]+:)+\s+/u, '');
    const match = /^(?:ok|not ok)\s+\d+\s+-\s+(.+?)\s+#\s+SKIP\b/u.exec(stripped);
    if (match?.[1]) names.push(match[1].trim());
  }
  return names;
}

/** Splits one TAP skip title into `>`-separated hierarchy components. */
function hierarchyParts(name) {
  return name
    .split(/\s*>\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Authorizes a TAP skip only when a reporter suffix uniquely matches one discovered test file. */
function fileBoundSkipIsAllowed(parts, declarations, discoveredTestFiles) {
  if (!Array.isArray(declarations) || declarations.length === 0) return false;
  if (!Array.isArray(discoveredTestFiles) || discoveredTestFiles.length === 0) return false;
  const reporterFiles = parts
    .map((part) => part.replace(/^\.\//u, '').split('\\').join('/'))
    .filter((part) => TEST_FILE.test(part));
  if (reporterFiles.length === 0) return false;
  const matchedFiles = new Set();
  for (const reporterFile of reporterFiles) {
    const matches = discoveredTestFiles.filter((file) => pathSuffixMatch(file, reporterFile));
    if (matches.length !== 1) return false;
    matchedFiles.add(matches[0]);
  }
  if (matchedFiles.size !== 1) return false;
  const file = [...matchedFiles][0];
  const names = new Set(
    declarations
      .filter((declaration) => declaration.file === file)
      .map((declaration) => declaration.name)
  );
  const titleParts = parts.filter(
    (part) => !TEST_FILE.test(part.replace(/^\.\//u, '').split('\\').join('/'))
  );
  return titleParts.some((part) => names.has(part));
}

/** Returns whether one discovered path suffix-matches a reporter file component. */
function pathSuffixMatch(discoveredFile, reporterFile) {
  const discovered = discoveredFile.split('\\').join('/');
  const reporter = reporterFile.replace(/^\.\//u, '').split('\\').join('/');
  return (
    discovered === reporter ||
    discovered.endsWith(`/${reporter}`) ||
    reporter.endsWith(`/${discovered}`)
  );
}

/** Returns whether a skipIf/runIf platform predicate covers this node's test or suite subtree. */
function platformPredicateCovers(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isCallExpression(parent)) {
      const member = callMember(parent);
      if ((member === 'skipIf' || member === 'runIf') && isPlatformPredicate(parent.arguments[0])) {
        return true;
      }
      const callee = parent.expression;
      if (
        ts.isCallExpression(callee) &&
        (callMember(callee) === 'skipIf' || callMember(callee) === 'runIf') &&
        isPlatformPredicate(callee.arguments[0]) &&
        isFunctionLike(current)
      ) {
        return true;
      }
    }
    current = parent;
  }
  return false;
}

/** Returns whether one condition is a wholly pre-run predicate that names process.platform. */
function isPlatformPredicate(node) {
  return Boolean(node) && isDeclaredPreRunCondition(node) && containsProcessPlatform(node);
}

/** Returns whether one expression tree contains `process.platform`. */
function containsProcessPlatform(node) {
  let found = false;
  visit(node, (child) => {
    if (isProcessProperty(child, 'platform')) found = true;
  });
  return found;
}

/** Returns whether one node is a function expression used as a test or suite callback. */
function isFunctionLike(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** Collects imported and namespaced node:os platform and arch bindings. */
function nodeOsBindings(source) {
  const names = new Set();
  const namespaces = new Set();
  visit(source, (node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier)) return;
    if (node.moduleSpecifier.text !== 'node:os' && node.moduleSpecifier.text !== 'os') return;
    const clause = node.importClause;
    if (!clause) return;
    if (clause.name) namespaces.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (!bindings) return;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      return;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === 'arch' || imported === 'platform') names.add(element.name.text);
    }
  });
  return { names, namespaces };
}

/** Returns the identifier or property name invoked by one call expression. */
function calleeName(node) {
  if (!ts.isCallExpression(node)) return null;
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

/** Returns a literal docker, podman, or nerdctl command executed through child_process. */
function containerRuntimeInvocation(node) {
  const callee = calleeName(node);
  if (!CHILD_PROCESS_CALLEES.has(callee ?? '')) return null;
  const command = node.arguments[0];
  if (!command || !ts.isStringLiteralLike(command)) return null;
  const text = command.text.trim();
  if (SHELL_CALLEES.has(callee)) return shellContainerRuntime(text);
  return pathContainerRuntime(text);
}

/** Returns a container runtime named by a literal executable path. */
function pathContainerRuntime(text) {
  const base = posix.basename(text.replace(/\\/g, '/'));
  return CONTAINER_RUNTIMES.has(base) ? base : null;
}

/** Returns a container runtime from a shell string after bounded leading NAME=value tokens. */
function shellContainerRuntime(text) {
  const tokens = text.split(/\s+/u).filter(Boolean);
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index])) index += 1;
  if (index >= tokens.length) return null;
  return pathContainerRuntime(tokens[index]);
}

/** Returns whether one node is `process.<name>`. */
function isProcessProperty(node, name) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === name
  );
}

/**
 * Names one enumerated platform-interface family, or null when the node is outside the list.
 *
 * @param {ts.Node} node Current syntax node.
 * @param {{ names: Set<string>, namespaces: Set<string> }} osBindings Imported node:os bindings.
 * @returns {string|null} Finding text naming the family.
 */
function platformInterfaceFamily(node, osBindings) {
  if (isProcessProperty(node, 'platform')) {
    return 'undeclared process.platform platform interface';
  }
  if (ts.isCallExpression(node) && isProcessProperty(node.expression, 'kill')) {
    return 'undeclared process-group platform interface (process.kill or signal)';
  }
  if (ts.isPropertyAssignment(node)) {
    const name = ts.isIdentifier(node.name)
      ? node.name.text
      : ts.isStringLiteralLike(node.name)
        ? node.name.text
        : null;
    if (name === 'detached' && node.initializer.kind === ts.SyntaxKind.TrueKeyword) {
      return 'undeclared process-group platform interface (detached process group)';
    }
  }
  if (
    ts.isStringLiteralLike(node) &&
    ts.isCallExpression(node.parent) &&
    PLATFORM_PATH_CALLEES.has(calleeName(node.parent) ?? '')
  ) {
    if (node.text.startsWith('/proc') || node.text.startsWith('/sys/fs/cgroup')) {
      return 'undeclared /proc or cgroup platform interface';
    }
  }
  if (LINK_RESOLUTION_CALLEES.has(calleeName(node) ?? '')) {
    return 'undeclared realpath, readlink, or symlink link-resolution platform interface';
  }
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    osBindings.names.has(node.expression.text)
  ) {
    return `undeclared node:os platform interface os.${node.expression.text}`;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    osBindings.namespaces.has(node.expression.expression.text) &&
    (node.expression.name.text === 'arch' || node.expression.name.text === 'platform')
  ) {
    return `undeclared node:os platform interface os.${node.expression.name.text}`;
  }
  return null;
}

/** Formats one stable file and line finding. */
function finding(path, source, node, message) {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  return `${path}:${line}: ${message}`;
}

/** Returns repository-relative test paths discovered under one root. */
function relativeTestFiles(root) {
  return testFiles(root).map((path) => relative(root, path).split('\\').join('/'));
}

/** Collects file-bound test or suite names whose skip predicates are declared before execution. */
function declaredSkipNames(root) {
  const names = [];
  for (const path of testFiles(root)) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const file = relative(root, path).split('\\').join('/');
    visit(source, (node) => {
      if (!ts.isCallExpression(node) || !ts.isCallExpression(node.expression)) return;
      const declaration = node.expression;
      const member = callMember(declaration);
      if (member !== 'skipIf' && member !== 'runIf') return;
      const condition = declaration.arguments[0];
      const name = node.arguments[0];
      if (
        condition &&
        isDeclaredPreRunCondition(condition) &&
        name &&
        ts.isStringLiteralLike(name)
      ) {
        names.push({ file, name: name.text });
      }
    });
  }
  return names;
}

/** Runs the command-line projection. */
function main(argv) {
  if (argv[0] === '--run') {
    const separator = argv.indexOf('--');
    const command = separator === -1 ? [] : argv.slice(separator + 1);
    const root = process.cwd();
    const result = executeTestSuite({
      allowedSkipDeclarations: declaredSkipNames(root),
      command,
      discoveredTestFiles: relativeTestFiles(root),
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    report(result.errors);
    return;
  }
  report(validateTestGovernance(resolve(argv[0] ?? process.cwd())));
}

/** Prints findings and selects the CLI exit status. */
function report(errors) {
  if (errors.length === 0) return;
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
