import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ProviderReadinessSchema } from '@openkit/config-schema';
import { z } from 'zod';
import {
  type AgentManifest,
  type AuthoredAgentConfig,
  AuthoredAgentConfigSchema,
} from '../agents/manifest.js';
import { resolveAgentTransport } from '../agents/transport.js';
import { parseJsoncObject } from './jsonc.js';

/**
 * Agent manifest loader diagnostic.
 */
export interface AgentManifestDiagnostic {
  /** Stable diagnostic code. */
  code: 'agent.invalid_manifest';
  /** Source file path that produced the diagnostic. */
  path: string;
  /** Agent id when it could be read from the source document. */
  agentId?: string | undefined;
  /** Human-readable diagnostic message. */
  message: string;
  /** Diagnostic severity. */
  severity: 'error' | 'warning';
}

/**
 * Agent manifest load result.
 */
export interface AgentManifestLoadResult {
  /** Loaded authored agent configs. */
  configs: AuthoredAgentConfig[];
  /** Loaded agent manifests. */
  manifests: AgentManifest[];
  /** Blocking diagnostics discovered while loading manifests. */
  diagnostics: AgentManifestDiagnostic[];
}

/**
 * Loads every agent manifest under data/config/agents.
 *
 * @param dataRoot Data root to read.
 * @returns Loaded agent manifests and diagnostics.
 */
export function loadAgentManifests(dataRoot: string): AgentManifestLoadResult {
  const agentsRoot = join(dataRoot, 'config', 'agents');
  const result: AgentManifestLoadResult = { configs: [], diagnostics: [], manifests: [] };

  if (!existsSync(agentsRoot)) {
    return result;
  }

  for (const fileName of readdirSync(agentsRoot).sort()) {
    if (!fileName.endsWith('.agent.jsonc')) {
      continue;
    }

    const path = join(agentsRoot, fileName);
    const parsed = parseJsoncObject(readFileSync(path, 'utf8'), path);

    const authoredResult = AuthoredAgentConfigSchema.safeParse(parsed);

    if (!authoredResult.success) {
      result.diagnostics.push({
        code: 'agent.invalid_manifest',
        message: z.prettifyError(authoredResult.error),
        path,
        severity: 'error',
        agentId: readAgentId(parsed),
      });
      continue;
    }

    const validationErrors = validateAuthoredAgentConfig(authoredResult.data);

    if (validationErrors.length > 0) {
      result.diagnostics.push({
        code: 'agent.invalid_manifest',
        message: validationErrors.join('\n'),
        path,
        severity: 'error',
        agentId: authoredResult.data.id,
      });
      continue;
    }

    result.configs.push(authoredResult.data);
    result.manifests.push(authoredAgentConfigToManifest(authoredResult.data));
  }

  return result;
}

/**
 * Maps a v0.0.4 authored agent config into the current runtime manifest.
 *
 * @param config Authored agent config.
 * @returns Compatibility agent manifest.
 */
function authoredAgentConfigToManifest(config: AuthoredAgentConfig): AgentManifest {
  return {
    adapter: config.runtime.adapter,
    profiles: (config.profiles ?? []).map((profile) => ({
      displayName: String(profile.id),
      id: profile.id,
      ...(typeof profile.instructionsRef === 'string'
        ? { instructionsRef: profile.instructionsRef }
        : {}),
      ...(Array.isArray(profile.skills)
        ? { skills: profile.skills.filter((skill): skill is string => typeof skill === 'string') }
        : {}),
    })),
    deployments: [mapAuthoredModeToDeployment(config.mode)],
    displayName: config.displayName,
    ...(config.extensions ? { extensions: config.extensions } : {}),
    id: config.id,
    kind: mapAuthoredModeToManifestKind(config),
    ...(config.provider?.model ? { modelRef: config.provider.model } : {}),
    ...(config.provider?.ref ? { providerRef: config.provider.ref } : {}),
    ...mapAuthoredReadiness(config),
    runtime: config.runtime.kind,
    skills: (config.skills ?? []).map((skill) => skill.id),
    version: config.runtime.version ?? '1',
  };
}

/**
 * Maps authored readiness into the runtime readiness summary when possible.
 *
 * @param config Authored agent config.
 * @returns Runtime readiness field when the authored payload is a status summary.
 */
function mapAuthoredReadiness(config: AuthoredAgentConfig): Pick<AgentManifest, 'readiness'> {
  const readinessResult = config.readiness
    ? ProviderReadinessSchema.safeParse(config.readiness)
    : null;

  return readinessResult?.success ? { readiness: readinessResult.data } : {};
}

/**
 * Maps a v0.0.4 agent mode into the deployment enum.
 *
 * @param mode Authored agent mode.
 * @returns Deployment value.
 */
function mapAuthoredModeToDeployment(
  mode: AuthoredAgentConfig['mode']
): AgentManifest['deployments'][number] {
  return mode === 'remote' ? 'server' : 'local';
}

/**
 * Maps v0.0.4 runtime/mode fields into the manifest kind enum.
 *
 * @param config Authored agent config.
 * @returns Manifest kind.
 */
function mapAuthoredModeToManifestKind(config: AuthoredAgentConfig): AgentManifest['kind'] {
  return config.mode === 'remote' ? 'remote' : 'custom';
}

/**
 * Validates v0.0.4 agent safety rules that need cross-field checks.
 *
 * @param config Authored agent config.
 * @returns Human-readable validation errors.
 */
function validateAuthoredAgentConfig(config: AuthoredAgentConfig): string[] {
  return [
    ...validateUserRuntime(config),
    ...validateAgentTransport(config),
    ...validateWorkspacePaths(config),
    ...validateMcpCredentialRefs(config),
  ];
}

/**
 * Validates user-facing runtime restrictions.
 *
 * @param config Authored agent config.
 * @returns Human-readable validation errors.
 */
function validateUserRuntime(config: AuthoredAgentConfig): string[] {
  return config.runtime.kind === 'simulator'
    ? ['Simulator agents are internal-only and cannot be configured in DATA_ROOT/config/agents.']
    : [];
}

/**
 * Validates agent transport defaults and explicit overrides.
 *
 * @param config Authored agent config.
 * @returns Human-readable validation errors.
 */
function validateAgentTransport(config: AuthoredAgentConfig): string[] {
  try {
    resolveAgentTransport(config);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/**
 * Validates workspace path safety and overlap rules.
 *
 * @param config Authored agent config.
 * @returns Human-readable validation errors.
 */
function validateWorkspacePaths(config: AuthoredAgentConfig): string[] {
  const errors: string[] = [];
  const targets = [
    ...(config.workspace?.inputs ?? []).flatMap((input) => (input.target ? [input.target] : [])),
    ...(config.workspace?.filesystems ?? []).flatMap((filesystem) =>
      filesystem.mount ? [filesystem.mount] : []
    ),
  ];
  const normalizedTargets: string[] = [];

  for (const target of targets) {
    const normalized = normalizeWorkspacePath(target);

    if (isAbsolute(target)) {
      errors.push(`Workspace path must be relative, not absolute: ${target}`);
      continue;
    }

    if (target.split(/[\\/]+/).includes('..')) {
      errors.push(`Workspace path must not contain parent-directory escapes: ${target}`);
      continue;
    }

    normalizedTargets.push(normalized);
  }

  for (const [index, target] of normalizedTargets.entries()) {
    for (const other of normalizedTargets.slice(index + 1)) {
      if (pathsOverlap(target, other)) {
        errors.push(`Workspace targets overlap: ${target} and ${other}`);
      }
    }
  }

  return errors;
}

/**
 * Validates MCP credential restrictions.
 *
 * @param config Authored agent config.
 * @returns Human-readable validation errors.
 */
function validateMcpCredentialRefs(config: AuthoredAgentConfig): string[] {
  return (config.mcp ?? [])
    .filter((entry) => entry.mode === 'agent.local' && hasCredentialReference(entry))
    .map((entry) => `agent.local MCP entries must not declare credentials: ${entry.id}`);
}

/**
 * Checks for credential reference keys on one MCP entry.
 *
 * @param entry MCP entry to inspect.
 * @returns True when a credential reference is present.
 */
function hasCredentialReference(entry: Record<string, unknown>): boolean {
  return ['credentialRef', 'credentialsRef', 'secretRef'].some(
    (key) => typeof entry[key] === 'string'
  );
}

/**
 * Normalizes a workspace-relative path for overlap checks.
 *
 * @param path Workspace path.
 * @returns Normalized path without leading or trailing slashes.
 */
function normalizeWorkspacePath(path: string): string {
  return path.replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
}

/**
 * Checks whether two normalized workspace paths overlap.
 *
 * @param left First normalized path.
 * @param right Second normalized path.
 * @returns True when either path contains the other.
 */
function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Reads an agent id from an arbitrary parsed manifest.
 *
 * @param value Parsed manifest candidate.
 * @returns Agent id, when present.
 */
function readAgentId(value: unknown): string | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof (value as { id?: unknown }).id === 'string'
    ? (value as { id: string }).id
    : undefined;
}
