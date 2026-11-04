# @openkit/knowledge-ui

Shared browse, search, preview, edit, and import surface for OpenKit Web and omni-knowledge. This package renders only. It does not import a host client, a policy module, or `apps/web`.

## Adapter contract

A host implements `KnowledgeClient` from `src/client.ts` and passes it to `KnowledgeBrowser`.

- `KnowledgeNode.kind` is `folder`, `page`, or `file`. `parentId` is the parent folder, or `null` at the root.
- `list` and `search` return one page: `{ nodes, nextCursor }`. `nextCursor` is `null` when the host has no further page. The browser shows Load earlier only when `nextCursor` is a string.
- `read` returns `{ node, body, version }` and an optional `contentUrl`. Image and PDF previews use `contentUrl`. They never use a base64 body.
- `importFile` receives a `Blob` (a browser `File`). The package does not copy the bytes into a `Uint8Array`.
- `saveText` rejects with `{ kind: 'version-conflict', currentVersion }` when the host revision does not match `expectedVersion`. The browser shows that current version.
- `extensions.header` and `extensions.node` are optional host slots. The package calls them and does not know what they render. `extensions.rowId` sets the fragment id on the whole row so a host citation can include the title. Workspace scope, review, policy, citations, history, and repair stay in the host.

The OpenKit adapter lives in `apps/web` and returns `nextCursor: null` until the backend pages. The omni adapter is not in this repository.
