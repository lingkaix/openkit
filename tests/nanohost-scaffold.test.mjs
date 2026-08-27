import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const nanoHostRoot = join(repoRoot, 'apps', 'nanohost');
const cargoTomlPath = join(nanoHostRoot, 'Cargo.toml');
const mainRsPath = join(nanoHostRoot, 'src', 'main.rs');
const readmePath = join(nanoHostRoot, 'README.md');
const packageJsonPath = join(nanoHostRoot, 'package.json');
const miseTomlPath = join(nanoHostRoot, 'mise.toml');

/**
 * S-2a-1 freezes these four `apps/nanohost/src/` module names as the NanoHost
 * internal role layout. They project the four logical responsibility boundaries
 * from `docs/specs/20260802-nanohost_runtime_and_transport.md` (epoch
 * coordinator, NanoCore-session owner, OpenShell-client owner, per-sandbox
 * bridge owner). Later `apps/nanohost/src/` leases are cut against this layout.
 */
const ROLE_MODULES = Object.freeze([
  Object.freeze({ role: 'epoch coordinator', module: 'epoch_coordinator' }),
  Object.freeze({ role: 'NanoCore-session owner', module: 'nanocore_session' }),
  Object.freeze({ role: 'OpenShell-client owner', module: 'openshell_client' }),
  Object.freeze({ role: 'per-sandbox bridge owner', module: 'sandbox_bridge' }),
]);

const REQUIRED_PACKAGE_SCRIPTS = Object.freeze({
  build: /^cargo\s+build\b/u,
  test: /^cargo\s+test\b/u,
  // Ordinary verify:l0-l2 runs turbo lint; fmt --check must precede clippy.
  lint: /^cargo\s+fmt\s+--check\b.*&&\s*cargo\s+clippy\b/u,
  format: /^cargo\s+fmt\b/u,
});

/**
 * Reads a UTF-8 file relative to the NanoHost app root.
 *
 * @param {string} absolutePath Absolute path to read.
 * @param {string} obligation Failure label when the file is missing.
 * @returns {string} File contents.
 */
function readRequired(absolutePath, obligation) {
  assert.ok(existsSync(absolutePath), obligation);
  return readFileSync(absolutePath, 'utf8');
}

/**
 * Returns whether `src/<module>.rs` or `src/<module>/mod.rs` exists.
 *
 * @param {string} moduleName Rust module identifier.
 * @returns {boolean} True when one of the conventional module paths exists.
 */
function roleModuleSourceExists(moduleName) {
  const fileModule = join(nanoHostRoot, 'src', `${moduleName}.rs`);
  const dirModule = join(nanoHostRoot, 'src', moduleName, 'mod.rs');
  return existsSync(fileModule) || existsSync(dirModule);
}

/**
 * Returns whether `main.rs` declares `mod <moduleName>`.
 *
 * @param {string} mainSource Contents of `src/main.rs`.
 * @param {string} moduleName Rust module identifier.
 * @returns {boolean} True when the binary root declares the module.
 */
function mainDeclaresModule(mainSource, moduleName) {
  const pattern = new RegExp(`^\\s*mod\\s+${moduleName}\\s*;`, 'mu');
  return pattern.test(mainSource);
}

test('apps/nanohost is one Rust binary crate named nanohost', () => {
  const cargoToml = readRequired(
    cargoTomlPath,
    'NanoHost crate boundary obligation failed: apps/nanohost/Cargo.toml must exist'
  );

  assert.match(
    cargoToml,
    /^\[package\]/mu,
    'NanoHost crate boundary obligation failed: Cargo.toml must declare [package]'
  );
  assert.match(
    cargoToml,
    /^name\s*=\s*"nanohost"/mu,
    'NanoHost crate boundary obligation failed: [package].name must be "nanohost"'
  );

  const hasDefaultBinary = existsSync(mainRsPath);
  const hasExplicitBin = /^\[\[bin\]\]/mu.test(cargoToml);
  assert.ok(
    hasDefaultBinary || hasExplicitBin,
    'NanoHost crate boundary obligation failed: apps/nanohost must be a binary crate (src/main.rs or [[bin]])'
  );
});

test('apps/nanohost/src declares the four frozen internal role modules', () => {
  const mainSource = readRequired(
    mainRsPath,
    'NanoHost role-module obligation failed: apps/nanohost/src/main.rs must exist to declare role modules'
  );

  for (const { role, module } of ROLE_MODULES) {
    assert.ok(
      roleModuleSourceExists(module),
      `NanoHost role-module obligation failed: ${role} requires src/${module}.rs or src/${module}/mod.rs`
    );
    assert.ok(
      mainDeclaresModule(mainSource, module),
      `NanoHost role-module obligation failed: src/main.rs must declare mod ${module} for ${role}`
    );
  }
});

test('apps/nanohost ships README.md and package.json with Cargo-backed scripts', () => {
  assert.ok(
    existsSync(readmePath),
    'NanoHost app-guide obligation failed: apps/nanohost/README.md must exist'
  );

  const packageJson = readRequired(
    packageJsonPath,
    'NanoHost package obligation failed: apps/nanohost/package.json must exist'
  );
  const manifest = JSON.parse(packageJson);

  assert.equal(
    manifest.name,
    '@openkit/nanohost',
    'NanoHost package obligation failed: package.json name must be @openkit/nanohost'
  );

  const scripts = manifest.scripts;
  assert.equal(
    typeof scripts,
    'object',
    'NanoHost package obligation failed: package.json must declare scripts'
  );
  assert.ok(
    scripts !== null,
    'NanoHost package obligation failed: package.json scripts must be an object'
  );

  for (const [scriptName, pattern] of Object.entries(REQUIRED_PACKAGE_SCRIPTS)) {
    const value = scripts[scriptName];
    assert.equal(
      typeof value,
      'string',
      `NanoHost package obligation failed: package.json scripts.${scriptName} must exist`
    );
    assert.match(
      value,
      pattern,
      `NanoHost package obligation failed: scripts.${scriptName} must invoke the matching cargo command`
    );
  }
});

test('apps/nanohost/mise.toml still pins rust 1.97.1', () => {
  const miseToml = readRequired(
    miseTomlPath,
    'NanoHost toolchain pin obligation failed: apps/nanohost/mise.toml must exist'
  );
  assert.match(
    miseToml,
    /^rust\s*=\s*"1\.97\.1"/mu,
    'NanoHost toolchain pin obligation failed: mise.toml must pin rust = "1.97.1"'
  );
});
