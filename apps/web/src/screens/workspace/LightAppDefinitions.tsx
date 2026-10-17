import {
  LIGHT_APP_KERNEL_FORMAT_VERSION,
  LightAppDefinitionExportSchema,
  LightAppSchemaInputSchema,
  type OperationOutput,
} from '@openkit/app-api-schemas';
import { createRequestId } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useConnection, useCoreClient } from '../../app/core-client';
import { Button, Card, ErrorBanner, TextField } from '../../primitives';

/** An explicitly inspected parent; it applies only to the same authored catalog entry ID. */
interface DefinitionParent {
  entryId: string;
  digest: string;
}

/** A pending explicit command; each invocation gets one request identity and is never replayed by Query. */
interface Change {
  run: () => Promise<unknown>;
  completed?: () => void;
}

/** Invalidates definition and live projections after a mutation, including an uncertain failure. */
function useLightAppChange(workspaceId: string) {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (change: Change) => change.run(),
    retry: false,
    onSuccess: (_result, change) => change.completed?.(),
    onSettled: async () => {
      await Promise.all([
        queries.invalidateQueries({ queryKey: ['light-app-definitions', workspaceId] }),
        queries.invalidateQueries({ queryKey: ['light-apps', workspaceId] }),
        queries.invalidateQueries({ queryKey: ['catalog', workspaceId] }),
        queries.invalidateQueries({ queryKey: ['generative-presentation', workspaceId] }),
      ]);
    },
  });
}

/** Fixed product copy avoids exposing untrusted server errors or secret content. */
function ChangeFailure({ failed }: { failed: boolean }) {
  return failed ? (
    <ErrorBanner message="Couldn't complete that Light App change. Refresh and inspect the current state before trying again." />
  ) : null;
}

/** Reusable definitions and explicit app activation in the existing Workspace Catalog. */
export function LightAppDefinitions({
  workspaceId,
  blocked,
}: {
  workspaceId: string;
  blocked: boolean;
}) {
  const client = useCoreClient();
  const connection = useConnection();
  const [entryId, setEntryId] = useState<string | null>(null);
  const [parent, setParent] = useState<DefinitionParent | null>(null);
  const list = useQuery({
    queryKey: ['light-app-definitions', workspaceId, 'list'],
    queryFn: () => client.operations['catalog.light-app-list']({ workspaceId }),
    retry: false,
  });
  const readBlocked = blocked || connection.checking || connection.failed;
  const writeBlocked = readBlocked || list.isFetching || !list.isSuccess;
  return (
    <Card>
      <h2 className="text-sm font-bold text-fg">Light Apps</h2>
      <p className="text-xs text-fg-muted">
        Definitions are reusable templates. Importing, selecting a default, or pinning a version
        does not change live app data.
      </p>
      <Button
        size="sm"
        isDisabled={readBlocked || list.isFetching}
        onPress={() => void list.refetch()}
      >
        Refresh Light Apps
      </Button>
      {list.isPending ? <p>Loading Light App definitions…</p> : null}
      {list.isError ? (
        <ErrorBanner message="Couldn't load Light App definitions. Refresh before making changes." />
      ) : null}
      <div className="flex flex-col gap-3">
        {list.data?.entries.map((entry) => (
          <Button
            key={entry.id}
            size="sm"
            isDisabled={readBlocked}
            onPress={() => {
              if (entry.id !== entryId) setParent(null);
              setEntryId(entry.id);
            }}
          >
            Inspect definition {entry.displayName}
          </Button>
        ))}
        {list.isSuccess && !list.data.entries.length ? <p>No Light App definitions.</p> : null}
        <DefinitionImport
          workspaceId={workspaceId}
          revision={list.data?.revision}
          parent={parent}
          blocked={writeBlocked}
        />
        {entryId ? (
          <DefinitionDetails
            key={`${workspaceId}:${entryId}`}
            workspaceId={workspaceId}
            entryId={entryId}
            onChooseVersion={(digest) => setParent({ entryId, digest })}
            blocked={writeBlocked}
          />
        ) : null}
      </div>
    </Card>
  );
}

/** Retains the selected file and authored names until an explicit successful import. */
function DefinitionImport({
  workspaceId,
  revision,
  parent,
  blocked,
}: {
  workspaceId: string;
  revision: number | undefined;
  parent: DefinitionParent | null;
  blocked: boolean;
}) {
  const client = useCoreClient();
  const change = useLightAppChange(workspaceId);
  const [entryId, setEntryId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [historyFile, setHistoryFile] = useState<File | null>(null);
  const [historyEntryId, setHistoryEntryId] = useState('');
  const [reading, setReading] = useState(false);
  const active = useRef(true);
  const readingFile = useRef(false);
  const latest = useRef({
    blocked,
    revision,
    file,
    historyFile,
    entryId,
    historyEntryId,
    displayName,
    parent,
  });
  latest.current = {
    blocked,
    revision,
    file,
    historyFile,
    entryId,
    historyEntryId,
    displayName,
    parent,
  };
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [inputError, setInputError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const historyInput = useRef<HTMLInputElement>(null);
  const disabled = blocked || reading || change.isPending;
  /** Reads only the selected declarative JSON, with a byte bound before parsing. */
  async function importFile(history: boolean) {
    const selected = history ? historyFile : file;
    if (!selected || disabled || readingFile.current || revision === undefined) return;
    setInputError(null);
    if (!history && selected.size > 256 * 1024) {
      setInputError('Choose a JSON file no larger than 256 KiB.');
      return;
    }
    readingFile.current = true;
    setReading(true);
    try {
      const value: unknown = JSON.parse(await selected.text());
      // File reads can finish after navigation, disconnection, or a refreshed revision. Such reads never submit.
      const now = latest.current;
      if (
        !active.current ||
        now.blocked ||
        now.revision !== revision ||
        now.entryId !== entryId ||
        now.historyEntryId !== historyEntryId ||
        now.displayName !== displayName ||
        now.parent !== parent ||
        (history ? now.historyFile : now.file) !== selected
      )
        return;
      if (history) {
        const parsed = LightAppDefinitionExportSchema.safeParse(value);
        if (!parsed.success) {
          setInputError('Choose a valid Light App history export.');
          return;
        }
        change.mutate({
          run: () =>
            client.operations['catalog.light-app-history-import']({
              workspaceId,
              expectedRevision: revision,
              requestId: createRequestId(),
              export: parsed.data,
              ...(historyEntryId ? { entryId: historyEntryId } : {}),
            }),
          completed: () => {
            setHistoryFile(null);
            setHistoryEntryId('');
            if (historyInput.current) historyInput.current.value = '';
          },
        });
      } else {
        const parsed = LightAppSchemaInputSchema.safeParse(value);
        if (!parsed.success) {
          setInputError('Choose a valid Light App definition JSON file.');
          return;
        }
        change.mutate({
          run: () =>
            client.operations['catalog.light-app-import']({
              workspaceId,
              expectedRevision: revision,
              requestId: createRequestId(),
              entryId,
              displayName,
              definition: parsed.data,
              selectDefault: false,
              ...(parent?.entryId === entryId ? { parentDigest: parent.digest } : {}),
            }),
          completed: () => {
            setFile(null);
            setEntryId('');
            setDisplayName('');
            if (fileInput.current) fileInput.current.value = '';
          },
        });
      }
    } catch {
      if (active.current) setInputError("Couldn't read that JSON file.");
    } finally {
      readingFile.current = false;
      if (active.current) setReading(false);
    }
  }
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <h3 className="text-sm font-bold text-fg">Import a definition</h3>
      <TextField
        label="Light App catalog ID"
        value={entryId}
        onChange={setEntryId}
        placeholder="customer-notes"
        description="Use the existing ID to add a version."
        isDisabled={disabled}
      />
      {parent?.entryId === entryId ? (
        <p className="break-all text-xs text-fg-muted">
          Parent version for {entryId}: {parent.digest}
        </p>
      ) : (
        <p className="text-xs text-fg-muted">
          Choose a retained version to use it as the parent when importing an update for the same
          catalog ID.
        </p>
      )}
      <TextField
        label="Light App display name"
        value={displayName}
        onChange={setDisplayName}
        placeholder="Customer notes"
        isDisabled={disabled}
      />
      <label className="text-xs text-fg">
        Definition JSON file
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          disabled={disabled}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setInputError(null);
          }}
        />
      </label>
      {file ? <p className="text-xs text-fg-muted">Selected file: {file.name}</p> : null}
      <Button
        size="sm"
        isDisabled={disabled || !file || !entryId || !displayName.trim()}
        onPress={() => void importFile(false)}
      >
        Import definition
      </Button>
      <p className="text-xs text-fg-muted">
        Import history preserves its original versions, parents, actors and times. It does not
        select defaults or pins and contains no live app data.
      </p>
      <TextField
        label="History import catalog ID"
        value={historyEntryId}
        onChange={setHistoryEntryId}
        placeholder="customer-notes"
        description="Leave empty to retain the exported ID."
        isDisabled={disabled}
      />
      <label className="text-xs text-fg">
        Definition history JSON file
        <input
          ref={historyInput}
          type="file"
          accept=".json,application/json"
          disabled={disabled}
          onChange={(event) => {
            setHistoryFile(event.target.files?.[0] ?? null);
            setInputError(null);
          }}
        />
      </label>
      {historyFile ? (
        <p className="text-xs text-fg-muted">Selected history file: {historyFile.name}</p>
      ) : null}
      <Button size="sm" isDisabled={disabled || !historyFile} onPress={() => void importFile(true)}>
        Import definition history
      </Button>
      {inputError ? <ErrorBanner message={inputError} /> : null}
      <ChangeFailure failed={change.isError} />
    </div>
  );
}

/** Exact retained version inspection is independent of the app's active data. */
function DefinitionDetails({
  workspaceId,
  entryId,
  onChooseVersion,
  blocked,
}: {
  workspaceId: string;
  entryId: string;
  onChooseVersion: (digest: string) => void;
  blocked: boolean;
}) {
  const client = useCoreClient();
  const change = useLightAppChange(workspaceId);
  const [digest, setDigest] = useState<string | null>(null);
  const [download, setDownload] = useState<string | null>(null);
  const read = useQuery({
    queryKey: ['light-app-definitions', workspaceId, entryId],
    queryFn: () => client.operations['catalog.light-app-read']({ workspaceId, entryId }),
    retry: false,
  });
  const version = read.data?.versions.find((item) => item.digest === digest);
  const disabled = blocked || read.isFetching || !read.isSuccess || change.isPending;
  const unavailable = read.data?.entry.availability !== 'available';
  const revision = read.data?.revision;
  const [exportError, setExportError] = useState(false);
  const exportRead = useMutation({
    mutationFn: () => client.operations['catalog.light-app-export']({ workspaceId, entryId }),
    retry: false,
    onSuccess: (value) => {
      setExportError(false);
      setDownload(
        `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(value, null, 2))}`
      );
    },
    onError: () => setExportError(true),
  });
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <h3 className="text-sm font-bold text-fg">
        Definition: {read.data?.entry.displayName ?? entryId}
      </h3>
      <Button
        size="sm"
        isDisabled={blocked || read.isFetching}
        onPress={() => {
          setDownload(null);
          void read.refetch();
        }}
      >
        Refresh definition
      </Button>
      {read.isError ? (
        <ErrorBanner message="Couldn't read this definition. Other definitions remain available." />
      ) : null}
      {read.data ? (
        <p className="text-xs text-fg-muted">
          Default: {read.data.entry.currentDigest ?? 'None'} · Pin:{' '}
          {read.data.pin?.digest ?? 'None'} · {read.data.entry.availability}
        </p>
      ) : null}
      {read.data?.versions.map((item) => (
        <Button
          key={item.digest}
          aria-label={`Choose version ${item.digest}`}
          size="sm"
          isDisabled={blocked || read.isFetching}
          onPress={() => {
            setDigest(item.digest);
            onChooseVersion(item.digest);
          }}
        >
          Choose version {item.digest.slice(7, 19)}
        </Button>
      ))}
      <Button
        size="sm"
        isDisabled={disabled || exportRead.isPending}
        onPress={() => exportRead.mutate()}
      >
        Export definition history
      </Button>
      {download ? (
        <a className="text-sm text-accent" href={download} download={`${entryId}-history.json`}>
          Download definition history
        </a>
      ) : null}
      {exportError ? <ErrorBanner message="Couldn't export definition history." /> : null}
      {version ? (
        <>
          <p className="break-all text-xs text-fg-muted">Version: {version.digest}</p>
          <p className="break-all text-xs text-fg-muted">
            Parent: {version.parentDigest ?? 'None'}
          </p>
          <p className="text-xs text-fg-muted">
            Actor: {version.producer.kind} {version.producer.id}
          </p>
          <p className="text-xs text-fg-muted">Created: {version.createdAt}</p>
          <details>
            <summary className="text-sm text-fg">Read definition JSON</summary>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs text-fg-muted">
              {version.definitionJson}
            </pre>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              isDisabled={
                disabled || unavailable || version.digest === read.data?.entry.currentDigest
              }
              onPress={() => {
                if (revision === undefined) return;
                change.mutate({
                  run: () =>
                    client.operations['catalog.light-app-select']({
                      workspaceId,
                      entryId,
                      expectedRevision: revision,
                      requestId: createRequestId(),
                      digest: version.digest,
                      expectedCurrentDigest: read.data?.entry.currentDigest ?? null,
                    }),
                });
              }}
            >
              Use as default
            </Button>
            <Button
              size="sm"
              isDisabled={disabled || unavailable || version.digest === read.data?.pin?.digest}
              onPress={() => {
                if (revision === undefined) return;
                change.mutate({
                  run: () =>
                    client.operations['catalog.light-app-pin']({
                      workspaceId,
                      entryId,
                      expectedRevision: revision,
                      requestId: createRequestId(),
                      digest: version.digest,
                      expectedPinDigest: read.data?.pin?.digest ?? null,
                    }),
                });
              }}
            >
              Pin exact version
            </Button>
            <Button
              size="sm"
              isDisabled={disabled || !read.data?.pin}
              onPress={() => {
                if (revision === undefined) return;
                change.mutate({
                  run: () =>
                    client.operations['catalog.light-app-pin']({
                      workspaceId,
                      entryId,
                      expectedRevision: revision,
                      requestId: createRequestId(),
                      digest: null,
                      expectedPinDigest: read.data?.pin?.digest ?? null,
                    }),
                });
              }}
            >
              Unpin definition
            </Button>
            <Button
              size="sm"
              isDisabled={disabled || unavailable}
              onPress={() =>
                change.mutate({
                  run: () =>
                    client.operations['kernel.apps.instantiate']({
                      workspaceId,
                      entryId,
                      digest: version.digest,
                      requestId: createRequestId(),
                    }),
                })
              }
            >
              Create Light App
            </Button>
          </div>
          <ChangeFailure failed={change.isError} />
          <LiveApps
            key={`${entryId}:${version.digest}`}
            workspaceId={workspaceId}
            entryId={entryId}
            digest={version.digest}
            blocked={disabled || unavailable}
          />
        </>
      ) : null}
    </div>
  );
}

/** Paged live instances stay separate from reusable definition identity. */
function LiveApps({
  workspaceId,
  entryId,
  digest,
  blocked,
}: {
  workspaceId: string;
  entryId: string;
  digest: string;
  blocked: boolean;
}) {
  const client = useCoreClient();
  const [appId, setAppId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const apps = useQuery({
    queryKey: ['light-apps', workspaceId, 'list', page],
    queryFn: () => client.operations['kernel.apps.list']({ workspaceId, page, perPage: 100 }),
    retry: false,
  });
  const selectedExists = apps.data?.items.some((app) => app.appId === appId);
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <h3 className="text-sm font-bold text-fg">Live apps</h3>
      <p className="text-xs text-fg-muted">
        Choose an app to apply the selected definition. Applying first saves an automatic snapshot.
        Definition selection alone leaves all app data unchanged.
      </p>
      <Button size="sm" isDisabled={blocked || apps.isFetching} onPress={() => void apps.refetch()}>
        Refresh live apps
      </Button>
      {apps.isError ? <ErrorBanner message="Couldn't list live apps." /> : null}
      {apps.data?.items.map((app) => (
        <Button
          key={app.appId}
          size="sm"
          isDisabled={blocked || apps.isFetching}
          onPress={() => setAppId(app.appId)}
        >
          Inspect app {app.title}
        </Button>
      ))}
      {apps.isSuccess && !apps.data.items.length ? <p>No live apps.</p> : null}
      {apps.data && apps.data.totalPages > 1 ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            isDisabled={blocked || apps.isFetching || page <= 1}
            onPress={() => {
              setAppId(null);
              setPage(page - 1);
            }}
          >
            Previous apps
          </Button>
          <p>
            Page {page} of {apps.data.totalPages}
          </p>
          <Button
            size="sm"
            isDisabled={blocked || apps.isFetching || page >= apps.data.totalPages}
            onPress={() => {
              setAppId(null);
              setPage(page + 1);
            }}
          >
            Next apps
          </Button>
        </div>
      ) : null}
      {appId && selectedExists ? (
        <AppActivation
          key={`${workspaceId}:${appId}:${entryId}:${digest}`}
          workspaceId={workspaceId}
          appId={appId}
          entryId={entryId}
          digest={digest}
          blocked={blocked || apps.isFetching || !apps.isSuccess}
        />
      ) : null}
    </div>
  );
}

/** Captures restore consent with the exact app revision; changing any target remounts this scope. */
function AppActivation({
  workspaceId,
  appId,
  entryId,
  digest,
  blocked,
}: {
  workspaceId: string;
  appId: string;
  entryId: string;
  digest: string;
  blocked: boolean;
}) {
  const client = useCoreClient();
  const change = useLightAppChange(workspaceId);
  const [restore, setRestore] = useState<{ snapshotId: string; appRevision: number } | null>(null);
  const app = useQuery({
    queryKey: ['light-apps', workspaceId, appId],
    queryFn: () => client.operations['kernel.apps.get']({ workspaceId, appId }),
    retry: false,
    staleTime: 0,
  });
  const snapshots = useQuery({
    queryKey: ['light-apps', workspaceId, appId, 'snapshots'],
    queryFn: () => client.operations['kernel.snapshots.list']({ workspaceId, appId }),
    retry: false,
  });
  const disabled = blocked || app.isFetching || !app.isSuccess || change.isPending;
  const current = app.data;
  const canUpgrade = current?.lifecycle === 'unavailable' && current.kernelFormatVersion === 1;
  return (
    <div className="flex flex-col gap-3">
      <h4 className="text-sm font-bold text-fg">App: {current?.title ?? appId}</h4>
      <Button
        size="sm"
        isDisabled={blocked || app.isFetching || snapshots.isFetching}
        onPress={() => {
          setRestore(null);
          void app.refetch();
          void snapshots.refetch();
        }}
      >
        Refresh selected app
      </Button>
      {app.isError ? (
        <ErrorBanner message="Couldn't read this app. Refresh before changing it." />
      ) : null}
      {current ? (
        <p className="break-all text-xs text-fg-muted">
          {current.lifecycle} · App revision {current.appRevision} · Schema revision{' '}
          {current.schemaRevision} · Format {current.kernelFormatVersion ?? 'Unknown'} · Active
          definition {current.definitionVersion ?? 'Unknown'}
        </p>
      ) : null}
      {current?.lifecycle === 'unavailable' ? (
        <p className="text-xs text-fg-muted">
          This app is unavailable. Its data cannot be changed until its format and definition are
          usable.
        </p>
      ) : null}
      <Button
        size="sm"
        isDisabled={disabled || current?.lifecycle !== 'active'}
        onPress={() => {
          if (!current) return;
          setRestore(null);
          change.mutate({
            run: () =>
              client.operations['kernel.schema.activate']({
                workspaceId,
                appId,
                entryId,
                digest,
                expectedAppRevision: current.appRevision,
                expectedSchemaRevision: current.schemaRevision,
                requestId: createRequestId(),
              }),
          });
        }}
      >
        Apply definition to this app
      </Button>
      {canUpgrade ? (
        <Button
          size="sm"
          isDisabled={disabled}
          onPress={() => {
            if (!current) return;
            setRestore(null);
            change.mutate({
              run: () =>
                client.operations['kernel.format.upgrade']({
                  workspaceId,
                  appId,
                  expectedAppRevision: current.appRevision,
                  requestId: createRequestId(),
                }),
            });
          }}
        >
          Upgrade app format to {LIGHT_APP_KERNEL_FORMAT_VERSION}
        </Button>
      ) : null}
      <h4 className="text-sm font-bold text-fg">Automatic snapshots</h4>
      {snapshots.isError ? (
        <ErrorBanner message="Couldn't list this app's snapshots. App inspection remains available." />
      ) : null}
      {snapshots.isSuccess && !snapshots.data.snapshots.length ? (
        <p>No automatic snapshots.</p>
      ) : null}
      {snapshots.data?.snapshots.map(
        (snapshot: OperationOutput<'kernel.snapshots.list'>['snapshots'][number]) => (
          <div key={snapshot.snapshotId} className="flex flex-col gap-2">
            <p className="break-all text-xs text-fg-muted">
              {snapshot.createdAt} ·{' '}
              {snapshot.reason === 'definition-migration'
                ? 'Before definition change'
                : 'Before format upgrade'}{' '}
              · App revision {snapshot.appRevision} · Schema revision {snapshot.schemaRevision} ·
              Format {snapshot.kernelFormatVersion} · Definition {snapshot.definitionVersion}
            </p>
            <Button
              size="sm"
              aria-label={`Restore snapshot ${snapshot.snapshotId}`}
              isDisabled={disabled || snapshots.isFetching || !snapshots.isSuccess}
              onPress={() => {
                if (current)
                  setRestore({ snapshotId: snapshot.snapshotId, appRevision: current.appRevision });
              }}
            >
              Restore snapshot {snapshot.snapshotId.slice(0, 8)}
            </Button>
          </div>
        )
      )}
      {restore ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-negative-fg">
            Restore snapshot {restore.snapshotId} for {current?.title ?? appId}. All data changes
            after this snapshot will be discarded. The saved definition and format will also be
            restored.
          </p>
          <Button
            size="sm"
            variant="negative"
            isDisabled={
              disabled ||
              snapshots.isFetching ||
              !snapshots.isSuccess ||
              current?.appRevision !== restore.appRevision
            }
            onPress={() => {
              change.mutate({
                run: () =>
                  client.operations['kernel.snapshots.rollback']({
                    workspaceId,
                    appId,
                    snapshotId: restore.snapshotId,
                    expectedAppRevision: restore.appRevision,
                    requestId: createRequestId(),
                  }),
                completed: () => setRestore(null),
              });
            }}
          >
            Confirm restore and discard later data
          </Button>
          <Button
            size="sm"
            variant="quiet"
            isDisabled={change.isPending}
            onPress={() => setRestore(null)}
          >
            Cancel restore
          </Button>
        </div>
      ) : null}
      <ChangeFailure failed={change.isError} />
    </div>
  );
}
