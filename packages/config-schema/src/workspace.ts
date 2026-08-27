import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

/**
 * Workspace data root source kinds supported by V1.
 */
export const WorkspaceRootKindSchema = z.literal('host-dir');

/**
 * Workspace data root access declaration.
 */
export const WorkspaceRootAccessSchema = z.enum(['read-only', 'read-write']);

/**
 * Authored workspace data root schema.
 */
export const WorkspaceRootSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9._-]+$/),
    kind: WorkspaceRootKindSchema,
    path: z
      .string()
      .min(1)
      .superRefine((value, ctx) => {
        if (!isSafeRelativeRootPath(value)) {
          ctx.addIssue({
            code: 'custom',
            message: 'Workspace root path must be relative and stay inside the workspace root.',
          });
        }
      }),
    access: WorkspaceRootAccessSchema,
    createIfMissing: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.createIfMissing && value.access !== 'read-write') {
      ctx.addIssue({
        code: 'custom',
        message: 'createIfMissing is only valid for read-write workspace roots.',
        path: ['createIfMissing'],
      });
    }
  });

/**
 * Authored workspace config workspace section schema.
 */
export const WorkspaceConfigWorkspaceSchema = z
  .object({
    assistant: z
      .object({
        repositoryInspection: z
          .object({
            enabled: z.boolean().default(true),
            excludedPaths: z
              .array(
                z
                  .string()
                  .min(1)
                  .superRefine((value, ctx) => {
                    if (!isSafeRelativeRootPath(value)) {
                      ctx.addIssue({
                        code: 'custom',
                        message:
                          'Repository inspection excluded paths must be relative and stay inside the repository root.',
                      });
                    }
                  })
              )
              .default([]),
          })
          .strict()
          .default({ enabled: true, excludedPaths: [] }),
      })
      .strict()
      .default({ repositoryInspection: { enabled: true, excludedPaths: [] } }),
    roots: z.array(WorkspaceRootSchema).default([]),
  })
  .strict();

/**
 * Authored workspace config schema.
 */
export const WorkspaceConfigSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    workspace: WorkspaceConfigWorkspaceSchema.optional(),
    extensions: z.record(z.string().min(1), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();

    for (const [index, root] of (value.workspace?.roots ?? []).entries()) {
      if (ids.has(root.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate workspace root id: ${root.id}.`,
          path: ['workspace', 'roots', index, 'id'],
        });
      }

      ids.add(root.id);
    }
  });

/**
 * Authored workspace root source.
 */
export type WorkspaceRoot = z.infer<typeof WorkspaceRootSchema>;

/**
 * Authored workspace config.
 */
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

/** Fields shared by every materialized workspace root passed to worker launch. */
interface MaterializedWorkspaceRootBase {
  /** Stable authored workspace root id. */
  id: string;
  /** Worker-visible path for V1 host workers. */
  workerPath: string;
  /** Declared access intent. */
  access: 'read-only' | 'read-write';
}

/** NanoCore-local directory root passed to worker launch. */
export interface MaterializedLocalWorkspaceRoot extends MaterializedWorkspaceRootBase {
  /** Resolved local directory source kind. */
  sourceKind: 'host-dir' | 'materialized-dir';
  /** Host path resolved under the workspace root. */
  sourcePath: string;
  /** Immutable Git commit captured for a local Git root, when applicable. */
  sourceCommit?: string;
}

/** Credential-free remote Git root selected from the Workspace source catalog. */
export interface MaterializedRemoteGitWorkspaceRoot extends MaterializedWorkspaceRootBase {
  /** Remote Git materialization discriminant. */
  sourceKind: 'remote-git';
  /** Exact remote commit selected before scheduler admission. */
  sourceCommit: string;
}

/** Materialized workspace root passed to worker launch. */
export type MaterializedWorkspaceRoot =
  | MaterializedLocalWorkspaceRoot
  | MaterializedRemoteGitWorkspaceRoot;

/**
 * Input accepted by workspace root materialization.
 */
export interface MaterializeWorkspaceRootsInput {
  /** Authored workspace config or raw candidate to parse. */
  config: unknown;
  /** Workspace-owned root directory used as the path boundary. */
  workspaceRoot: string;
  /** Whether allowed missing output roots should be created. */
  createMissing?: boolean;
}

/**
 * Machine-readable workspace root validation diagnostic.
 */
export interface WorkspaceRootDiagnostic {
  /** Stable diagnostic code. */
  code: string;
  /** JSON path or root id related to the error. */
  path: string;
  /** Human-readable diagnostic message. */
  message: string;
}

/**
 * Error thrown when a workspace root cannot be materialized safely.
 */
export class WorkspaceRootValidationError extends Error {
  /** Diagnostics that caused materialization to fail. */
  public readonly diagnostics: WorkspaceRootDiagnostic[];

  /**
   * Creates a workspace root validation error.
   *
   * @param diagnostics Diagnostics that caused materialization to fail.
   */
  public constructor(diagnostics: WorkspaceRootDiagnostic[]) {
    super(diagnostics[0]?.message ?? 'Workspace roots are invalid.');
    this.name = 'WorkspaceRootValidationError';
    this.diagnostics = diagnostics;
  }
}

/**
 * Materializes authored workspace roots into host-worker launch roots.
 *
 * @param input Workspace config, workspace boundary, and creation options.
 * @returns Materialized workspace roots.
 * @throws WorkspaceRootValidationError when any root cannot be resolved safely.
 */
export function materializeWorkspaceRoots(
  input: MaterializeWorkspaceRootsInput
): MaterializedWorkspaceRoot[] {
  const config = WorkspaceConfigSchema.parse(input.config);
  const workspaceRoot = realpathSync(input.workspaceRoot);
  const diagnostics: WorkspaceRootDiagnostic[] = [];
  const roots: MaterializedWorkspaceRoot[] = [];

  for (const root of config.workspace?.roots ?? []) {
    const resolvedPath = resolve(workspaceRoot, root.path);

    if (!isInsideRoot(workspaceRoot, resolvedPath)) {
      diagnostics.push({
        code: 'workspace_root_path_escape',
        path: `$.workspace.roots.${root.id}.path`,
        message: `Workspace root ${root.id} escapes the workspace root.`,
      });
      continue;
    }

    if (!existsSync(resolvedPath)) {
      if (input.createMissing && root.createIfMissing) {
        mkdirSync(resolvedPath, { recursive: true });
      } else {
        diagnostics.push({
          code: 'workspace_root_missing',
          path: `$.workspace.roots.${root.id}.path`,
          message: `Workspace root ${root.id} does not exist.`,
        });
        continue;
      }
    }

    const realPath = realpathSync(resolvedPath);

    if (!isInsideRoot(workspaceRoot, realPath)) {
      diagnostics.push({
        code: 'workspace_root_symlink_escape',
        path: `$.workspace.roots.${root.id}.path`,
        message: `Workspace root ${root.id} resolves outside the workspace root.`,
      });
      continue;
    }

    if (!statSync(realPath).isDirectory()) {
      diagnostics.push({
        code: 'workspace_root_not_directory',
        path: `$.workspace.roots.${root.id}.path`,
        message: `Workspace root ${root.id} is not a directory.`,
      });
      continue;
    }

    roots.push({
      id: root.id,
      sourceKind: root.kind,
      sourcePath: realPath,
      workerPath: realPath,
      access: root.access,
    });
  }

  if (diagnostics.length > 0) {
    throw new WorkspaceRootValidationError(diagnostics);
  }

  return roots;
}

/**
 * Checks whether a workspace root path uses the accepted relative V1 syntax.
 *
 * @param value Authored workspace root path.
 * @returns True when the path is accepted.
 */
function isSafeRelativeRootPath(value: string): boolean {
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')) {
    return false;
  }

  const segments = value.split('/');

  return segments.every((segment) => segment.length > 0 && segment !== '..');
}

/**
 * Checks whether a resolved path stays inside a root.
 *
 * @param root Real root path.
 * @param candidate Resolved candidate path.
 * @returns True when the candidate stays inside the root.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);

  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}
