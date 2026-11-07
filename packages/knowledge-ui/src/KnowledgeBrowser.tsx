import { type ReactNode, useEffect, useState } from 'react';
import { Button, Input, Label, TextField } from 'react-aria-components';
import {
  isKnowledgeVersionConflict,
  type KnowledgeClient,
  type KnowledgeNode,
  type KnowledgeRead,
} from './client';
import './knowledge.css';

/** Host slots. The package does not know what the host renders here. */
export interface KnowledgeExtensions {
  header?: ReactNode;
  node?: (node: KnowledgeNode) => ReactNode;
  /** Fragment id for the whole row, so a host citation includes the title and the slot. */
  rowId?: (node: KnowledgeNode) => string | undefined;
}

export interface KnowledgeBrowserProps {
  client: KnowledgeClient;
  parentId: string | null;
  extensions?: KnowledgeExtensions;
}

interface Listed {
  node: KnowledgeNode;
  snippet?: string;
}

/** Phone width matches the shell break. Absent matchMedia stays desktop so jsdom does too. */
function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(max-width: 799px)');
    const apply = () => setPhone(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);
  return phone;
}

function isImage(mediaType: string): boolean {
  return mediaType.startsWith('image/');
}

function isPdf(mediaType: string): boolean {
  return mediaType === 'application/pdf';
}

/**
 * Shared knowledge browser.
 * Necessity: OpenKit and omni need one browse, search, preview, edit, and import surface.
 * Ablation: copying the screen into each host drifts, and governance would leak into the layout.
 */
export function KnowledgeBrowser({ client, parentId, extensions }: KnowledgeBrowserProps) {
  const phone = usePhoneLayout();
  const [folderId, setFolderId] = useState<string | null>(parentId);
  const [rows, setRows] = useState<Listed[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<KnowledgeRead | null>(null);
  const [query, setQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [conflict, setConflict] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setFolderId(parentId);
  }, [parentId]);

  useEffect(() => {
    let cancelled = false;
    void client
      .list(folderId)
      .then((page) => {
        if (cancelled) return;
        setSearchQuery(null);
        setRows(page.nodes.map((node) => ({ node })));
        setNextCursor(page.nextCursor);
        setLoadError(null);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load this folder.');
      });
    return () => {
      cancelled = true;
    };
  }, [client, folderId]);

  async function openNode(node: KnowledgeNode) {
    if (node.kind === 'folder') {
      setSelected(null);
      setEditing(false);
      setFolderId(node.id);
      return;
    }
    try {
      const read = await client.read(node.id);
      setSelected(read);
      setDraft(read.body ?? '');
      setEditing(false);
      setConflict(null);
      setStatus(null);
    } catch {
      setStatus('Could not open that page.');
    }
  }

  async function loadEarlier() {
    if (!nextCursor) return;
    try {
      if (searchQuery) {
        const page = await client.search(searchQuery, nextCursor);
        setRows((current) => [
          ...current,
          ...page.nodes.map((hit) => ({ node: hit.node, snippet: hit.snippet })),
        ]);
        setNextCursor(page.nextCursor);
      } else {
        const page = await client.list(folderId, nextCursor);
        setRows((current) => [...current, ...page.nodes.map((node) => ({ node }))]);
        setNextCursor(page.nextCursor);
      }
    } catch {
      setStatus('Could not load earlier records.');
    }
  }

  async function submitSearch() {
    const text = query.trim();
    if (!text) return;
    try {
      const page = await client.search(text);
      setSearchQuery(text);
      setRows(page.nodes.map((hit) => ({ node: hit.node, snippet: hit.snippet })));
      setNextCursor(page.nextCursor);
      setSelected(null);
      setLoadError(null);
    } catch {
      setStatus('Could not search.');
    }
  }

  async function save() {
    if (!selected) return;
    setConflict(null);
    try {
      const saved = await client.saveText(selected.node.id, draft, selected.version);
      setSelected({ ...selected, body: draft, version: saved.version });
      setEditing(false);
      setStatus(null);
    } catch (error) {
      if (isKnowledgeVersionConflict(error)) {
        setConflict(error.currentVersion);
        return;
      }
      setStatus('Could not save this page.');
    }
  }

  async function importChosen(file: File) {
    try {
      const node = await client.importFile(folderId, file);
      setRows((current) => [{ node }, ...current]);
      setStatus(null);
    } catch {
      setStatus('Could not import that file.');
    }
  }

  const showSearch = !phone || searchOpen;
  const reading = phone && selected !== null;
  const layoutClass = [
    'knowledge-ui',
    phone ? 'knowledge-ui-phone' : '',
    reading ? 'knowledge-ui-reading' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={layoutClass}>
      <div className="knowledge-ui-list">
        {extensions?.header}
        {phone ? <Button onPress={() => setSearchOpen((open) => !open)}>Search</Button> : null}
        {showSearch ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitSearch();
            }}
          >
            <TextField value={query} onChange={setQuery}>
              <Label>Search</Label>
              <Input />
            </TextField>
            <Button type="submit">Search pages</Button>
          </form>
        ) : null}
        <label>
          Import file
          <input
            aria-label="Import file"
            type="file"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void importChosen(file);
            }}
          />
        </label>
        {loadError ? <p className="knowledge-ui-status">{loadError}</p> : null}
        <ul aria-label="Pages">
          {rows.map((row) => (
            <li
              key={row.node.id}
              id={extensions?.rowId?.(row.node)}
              tabIndex={extensions?.rowId ? -1 : undefined}
              className="knowledge-ui-row"
            >
              <button
                type="button"
                className="knowledge-ui-title"
                onClick={() => void openNode(row.node)}
              >
                {row.node.title}
              </button>
              {row.node.updatedAt ? (
                <time dateTime={row.node.updatedAt}>
                  {new Date(row.node.updatedAt).toLocaleString()}
                </time>
              ) : null}
              {row.snippet ? <p className="knowledge-ui-snippet">{row.snippet}</p> : null}
              {extensions?.node?.(row.node)}
            </li>
          ))}
        </ul>
        {nextCursor ? <Button onPress={() => void loadEarlier()}>Load earlier</Button> : null}
        {folderId !== parentId ? (
          <Button
            onPress={() => {
              setFolderId(parentId);
              setSelected(null);
            }}
          >
            Back
          </Button>
        ) : null}
      </div>
      <div className="knowledge-ui-preview">
        {reading ? (
          <Button
            onPress={() => {
              setSelected(null);
              setEditing(false);
            }}
          >
            Back
          </Button>
        ) : null}
        {selected ? (
          <article aria-label="Preview">
            <h2>{selected.node.title}</h2>
            {isImage(selected.node.mediaType) && selected.contentUrl ? (
              <img alt={selected.node.title} src={selected.contentUrl} />
            ) : null}
            {isPdf(selected.node.mediaType) && selected.contentUrl ? (
              <a className="knowledge-ui-download" href={selected.contentUrl}>
                Download
              </a>
            ) : null}
            {reading && extensions?.node ? (
              extensions.node(selected.node)
            ) : !isImage(selected.node.mediaType) &&
              !isPdf(selected.node.mediaType) &&
              selected.body ? (
              <p>{selected.body}</p>
            ) : null}
            {reading && extensions?.node ? null : selected.body !== null &&
              !isImage(selected.node.mediaType) &&
              !isPdf(selected.node.mediaType) ? (
              editing ? (
                <div>
                  <TextField value={draft} onChange={setDraft}>
                    <Label>Page body</Label>
                    <Input />
                  </TextField>
                  <Button onPress={() => void save()}>Save</Button>
                </div>
              ) : (
                <Button onPress={() => setEditing(true)}>Edit</Button>
              )
            ) : null}
            {conflict ? (
              <p className="knowledge-ui-conflict" role="alert">
                This page changed. Current version {conflict}.
              </p>
            ) : null}
          </article>
        ) : null}
        {status ? <p className="knowledge-ui-status">{status}</p> : null}
      </div>
    </div>
  );
}
