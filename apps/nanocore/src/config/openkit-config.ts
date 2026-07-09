import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type OpenKitConfig, OpenKitConfigSchema } from '@openkit/config-schema';
import { z } from 'zod';

import { parseJsoncObject } from './jsonc.js';
import { BootConfigError } from './mode.js';

export type { OpenKitConfig };
export { OpenKitConfigSchema };

/**
 * OpenKit config loader diagnostic.
 */
export interface OpenKitConfigDiagnostic {
  /** Human-readable diagnostic message. */
  message: string;
  /** Diagnostic severity. */
  severity: 'warning';
}

/**
 * Source selected by the OpenKit config loader.
 */
export type OpenKitConfigSource = 'absent' | 'config';

/**
 * OpenKit config loader result.
 */
export interface OpenKitConfigLoadResult {
  /** Parsed operator config. */
  config: OpenKitConfig;
  /** Diagnostics emitted while loading the config source. */
  diagnostics: OpenKitConfigDiagnostic[];
  /** Selected source path when a file was loaded. */
  path?: string;
  /** Selected source kind. */
  source: OpenKitConfigSource;
}

/**
 * Returns the OpenKit config path for one data root.
 *
 * @param dataRoot Data root directory.
 * @returns Absolute or relative path to data/config/server.jsonc.
 */
export function openKitConfigPath(dataRoot = 'data'): string {
  return join(dataRoot, 'config', 'server.jsonc');
}

/**
 * Loads and validates OpenKit config with diagnostics.
 *
 * @param dataRoot Data root directory that contains the config directory.
 * @returns Parsed config, selected source, and diagnostics.
 * @throws BootConfigError when JSONC parsing or schema validation fails.
 */
export function loadOpenKitConfigWithDiagnostics(dataRoot = 'data'): OpenKitConfigLoadResult {
  const configPath = openKitConfigPath(dataRoot);

  return existsSync(configPath)
    ? {
        config: loadConfigFile(configPath),
        diagnostics: [],
        path: configPath,
        source: 'config',
      }
    : { config: {}, diagnostics: [], source: 'absent' };
}

/**
 * Loads and validates OpenKit config.
 *
 * @param dataRoot Data root directory that contains the config directory.
 * @returns Parsed config, or an empty config when the file is absent.
 * @throws BootConfigError when JSONC parsing or schema validation fails.
 */
export function loadOpenKitConfig(dataRoot = 'data'): OpenKitConfig {
  return loadOpenKitConfigWithDiagnostics(dataRoot).config;
}

/**
 * Loads and validates one OpenKit config file.
 *
 * @param configPath Config file path to load.
 * @returns Parsed OpenKit config.
 * @throws BootConfigError when validation fails.
 */
function loadConfigFile(configPath: string): OpenKitConfig {
  const parsedJsonc = parseJsoncObject(readFileSync(configPath, 'utf8'), configPath);
  const parsedConfig = OpenKitConfigSchema.safeParse(parsedJsonc);

  if (!parsedConfig.success) {
    throw new BootConfigError(
      'invalid_openkit_config',
      `Invalid OpenKit config ${configPath}: ${z.prettifyError(parsedConfig.error)}`
    );
  }

  return parsedConfig.data;
}
