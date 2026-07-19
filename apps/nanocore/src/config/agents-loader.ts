import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { type AgentManifest, AuthoredAgentConfigSchema } from '../agents/manifest.js';
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
  const result: AgentManifestLoadResult = { diagnostics: [], manifests: [] };

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

    result.manifests.push(authoredResult.data);
  }

  return result;
}

/**
 * Validates agent safety rules that need filesystem-oriented checks.
 *
 * @param config Authored agent config.
 * @returns Human-readable validation errors.
 */
function validateAuthoredAgentConfig(config: AgentManifest): string[] {
  return [...validateUserRuntime(config), ...validateWorkspacePaths(config)];
}

/**
 * Validates user-facing runtime restrictions.
 *
 * @param config Authored agent config.
 * @returns Human-readable validation errors.
 */
function validateUserRuntime(config: AgentManifest): string[] {
  return config.runtime.kind === 'simulator'
    ? ['Simulator agents are internal-only and cannot be configured in DATA_ROOT/config/agents.']
    : [];
}

/**
 * Validates workspace path safety and overlap rules.
 *
 * @param config Authored agent config.
 * @returns Human-readable validation errors.
 */
function validateWorkspacePaths(config: AgentManifest): string[] {
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
