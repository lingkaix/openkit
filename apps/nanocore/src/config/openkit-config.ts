import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type OpenKitConfig as AuthoredOpenKitConfig,
  OpenKitConfigSchema,
} from '@openkit/config-schema';
import { readRetainedV1 } from '@openkit/protocol';
import { z } from 'zod';

import { parseJsoncObject } from './jsonc.js';
import { BootConfigError } from './mode.js';
import { unknownConfigKeyMessage, unknownConfigKeys } from './unknown-config-keys.js';

/** Resolved settings also represent the absent-file default; retained files require the authored marker. */
export type OpenKitConfig = Omit<AuthoredOpenKitConfig, 'schemaVersion'> & { schemaVersion?: 1 };
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
  if (!existsSync(configPath)) return { config: {}, diagnostics: [], source: 'absent' };
  return { ...loadConfigFile(configPath), path: configPath, source: 'config' };
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
function loadConfigFile(
  configPath: string
): Pick<OpenKitConfigLoadResult, 'config' | 'diagnostics'> {
  const parsedJsonc = parseJsoncObject(readFileSync(configPath, 'utf8'), configPath);
  let parsedConfig: ReturnType<typeof OpenKitConfigSchema.safeParse>;
  try {
    parsedConfig = readRetainedV1(parsedJsonc, (record) => OpenKitConfigSchema.safeParse(record));
  } catch {
    throw new BootConfigError(
      'invalid_openkit_config',
      `Invalid OpenKit config ${configPath}: Unsupported retained record format.`
    );
  }

  if (!parsedConfig.success) {
    throw new BootConfigError(
      'invalid_openkit_config',
      `Invalid OpenKit config ${configPath}: ${z.prettifyError(parsedConfig.error)}`
    );
  }

  return {
    config: parsedConfig.data,
    diagnostics: unknownConfigKeys('server', parsedJsonc, parsedConfig.data).map((key) => ({
      message: unknownConfigKeyMessage(key),
      severity: 'warning',
    })),
  };
}
