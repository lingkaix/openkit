import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { devNull } from 'node:os';
import { type WorkspaceChangedPath, WorkspaceChangedPathSchema } from '@openkit/app-api-schemas';

/** Splits the immutable native candidate and decodes Git and length-framed permission paths. */
export function readWorkspaceSnapshotCandidate(bytes: Buffer): {
  gitPatch: Buffer;
  changedPaths: WorkspaceChangedPath[];
  requiresRefinement: boolean;
} {
  const marker = Buffer.from('openkit-full-mode-delta\n');
  const lineOffset = bytes.indexOf(Buffer.concat([Buffer.from('\n'), marker]));
  const offset = bytes.subarray(0, marker.length).equals(marker)
    ? 0
    : lineOffset < 0
      ? -1
      : lineOffset + 1;
  const gitPatch = offset < 0 ? bytes : bytes.subarray(0, offset);
  let requiresRefinement = false;
  const paths = new Map<string, WorkspaceChangedPath>();
  if (gitPatch.length) {
    // Disable ambient repository discovery and its subdirectory prefix; this only parses supplied bytes.
    const stats = execFileSync(
      'git',
      [
        `--git-dir=${devNull}`,
        '-c',
        'core.quotePath=false',
        'apply',
        '--no-index',
        '--numstat',
        '-z',
      ],
      {
        input: gitPatch,
        maxBuffer: 256 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          LC_ALL: 'C',
        },
      }
    );
    for (const entry of new TextDecoder('utf-8', { fatal: true })
      .decode(stats)
      .split('\0')
      .filter(Boolean)) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error('Workspace candidate path statistics are malformed.');
      const path = match[3]!;
      paths.set(
        path,
        WorkspaceChangedPathSchema.parse({
          path,
          status: match[1] === '0' && match[2] === '0' ? 'mode_changed' : 'modified',
          binary: match[1] === '-',
          ...(match[1] === '-'
            ? {
                binaryReview: {
                  mode: 'artifact-only',
                  reason: 'binary-path',
                  // These facts identify the retained candidate artifact, not reconstructed file contents.
                  bytes: bytes.length,
                  digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
                  mediaType: 'application/octet-stream',
                  summary: `Binary change ${path} is retained in the workspace candidate artifact for artifact-only review.`,
                },
              }
            : {}),
        })
      );
    }
  }
  if (offset >= 0) {
    let cursor = offset + marker.length;
    let previous: Buffer | null = null;
    while (cursor < bytes.length) {
      const header = /^(----|[0-7]{4}) (----|[0-7]{4}) ([1-9][0-9]*) /.exec(
        bytes.subarray(cursor, cursor + 64).toString('ascii')
      );
      if (!header) throw new Error('Workspace candidate mode record is malformed.');
      const length = Number(header[3]);
      cursor += header[0].length;
      if (
        !Number.isSafeInteger(length) ||
        cursor + length >= bytes.length ||
        bytes[cursor + length] !== 10
      )
        throw new Error('Workspace candidate mode record length is invalid.');
      const raw = bytes.subarray(cursor, cursor + length);
      cursor += length + 1;
      if (previous && Buffer.compare(previous, raw) >= 0)
        throw new Error('Workspace candidate mode paths are unsorted or duplicated.');
      previous = raw;
      const path = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      const oldPermissions = header[1]!,
        newPermissions = header[2]!;
      if (
        oldPermissions === newPermissions ||
        (oldPermissions === '----' && newPermissions === '----')
      )
        throw new Error('Workspace candidate mode record has no delta.');
      if ([oldPermissions, newPermissions].some((mode) => !['----', '0644', '0755'].includes(mode)))
        requiresRefinement = true;
      const existing = paths.get(path);
      // Git cannot represent a manifest-only directory or other metadata path in this candidate.
      if (!existing) requiresRefinement = true;
      paths.set(
        path,
        WorkspaceChangedPathSchema.parse({
          ...existing,
          path,
          status:
            oldPermissions === '----'
              ? 'added'
              : newPermissions === '----'
                ? 'deleted'
                : existing
                  ? existing.status
                  : 'mode_changed',
          binary: existing?.binary ?? false,
          ...(/^0[0-7]{3}$/.test(oldPermissions) ? { oldPermissions } : {}),
          ...(/^0[0-7]{3}$/.test(newPermissions) ? { newPermissions } : {}),
        })
      );
    }
  }
  if (!paths.size) throw new Error('Workspace candidate has no changed paths.');
  return { gitPatch, changedPaths: [...paths.values()], requiresRefinement };
}
