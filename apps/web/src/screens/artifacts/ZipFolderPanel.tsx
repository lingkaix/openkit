import { useState } from 'react';
import { Button, ErrorBanner, StatusChip } from '../../primitives';
import { type ArtifactFolderInput, useArtifactFolder, useExtractArtifactFolder } from './data';

/** Explicit bounded ZIP inspection; original download remains on the Artifact surface. Remount with the exact source identity to discard prior pages and mutation state. */
export function ZipFolderPanel(props: { source: ArtifactFolderInput; disabled: boolean }) {
  const [offset, setOffset] = useState(0);
  const folder = useArtifactFolder(props.source, offset);
  const extract = useExtractArtifactFolder();
  const extractFailed =
    extract.isError || (extract.isSuccess && extract.data.status === 'unavailable');
  const ready =
    !extractFailed && folder.isSuccess && !folder.isFetching && folder.data.status === 'ready'
      ? folder.data
      : null;
  const pending = extract.isPending || folder.isFetching;
  return (
    <section className="flex flex-col gap-3" aria-label="ZIP folder snapshot">
      <p className="text-sm text-fg-muted">
        Keep this ZIP as a file, or explicitly extract a read-only folder snapshot. Nested ZIP files
        stay as files. The original stays unchanged.
      </p>
      {pending ? (
        <StatusChip tone="notice">
          {extract.isPending ? 'Extracting folder snapshot' : 'Checking folder snapshot'}
        </StatusChip>
      ) : null}
      {folder.isError ? (
        <ErrorBanner
          message="Folder status is unavailable. Check the original download."
          onRetry={() => void folder.refetch()}
        />
      ) : null}
      {extractFailed ? (
        <ErrorBanner
          message={
            extract.isError
              ? 'Folder extraction is unconfirmed. Check the original download before retrying.'
              : 'Folder extraction did not complete. The original file is retained. Retry uses the same original.'
          }
        />
      ) : null}
      <Button
        variant="outline"
        size="sm"
        isDisabled={props.disabled || pending || folder.isError}
        onPress={() => {
          extract.mutate(props.source, {
            onSuccess: () => {
              setOffset(0);
              void folder.refetch();
            },
          });
        }}
      >
        {ready
          ? 'Recheck folder snapshot'
          : extractFailed
            ? 'Retry folder extraction'
            : 'Extract ZIP as folder'}
      </Button>
      {ready && !extract.isPending ? (
        <>
          <p className="text-sm text-fg-muted">
            Folder snapshot ready: {ready.fileCount.toLocaleString()} files,{' '}
            {ready.directoryCount.toLocaleString()} directories,{' '}
            {ready.expandedBytes.toLocaleString()} expanded bytes.
          </p>
          <ul className="text-sm text-fg">
            {ready.entries.map((entry) => (
              <li key={entry.relativePath} className="break-all">
                {entry.relativePath} · {entry.byteLength.toLocaleString()} bytes
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            {offset > 0 ? (
              <Button
                size="sm"
                variant="quiet"
                onPress={() => setOffset(Math.max(0, offset - 100))}
              >
                Previous files
              </Button>
            ) : null}
            {ready.nextOffset !== null ? (
              <Button size="sm" variant="quiet" onPress={() => setOffset(ready.nextOffset!)}>
                Next files
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
