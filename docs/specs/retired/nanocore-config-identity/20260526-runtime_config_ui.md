# Runtime Config UI Management

Status: Superseded

Superseded by: [NanoCore Config And Identity Contract](../../20260628-nanocore_config_identity_contract.md)

Reference status: retained for detailed historical auth, identity, config, and data-layout context after consolidation.

## Summary

OpenKit Settings should let an authorized operator inspect, create, edit, validate, save, dry-run, and reload NanoCore runtime configuration without giving the web app direct filesystem access.

The UI is a source editor for JSONC files, not a form-based config builder.

NanoCore remains the authority for parsing, schema validation, semantic validation, diffing, and reload decisions.

The first implementation supports only manual user actions.

It does not add file watching, delete operations, collaborative editing, or automatic reload after save.

## Goals / Non-goals

### Goals

1. Expose the canonical runtime config files in Settings.
2. Preserve JSONC source text, comments, trailing commas, and formatting when users edit files.
3. Provide useful editor behavior through CodeMirror without moving config authority into the browser.
4. Validate drafts through NanoCore before or after saving.
5. Save files with revision protection so an older browser draft cannot silently overwrite disk changes.
6. Let users dry-run and apply the existing runtime config reload workflow from Settings.
7. Keep reload last-known-good semantics: invalid config never replaces the active snapshot.
8. Show runtime config version, reload status, pending restart items, validation diagnostics, and stale session markers.

### Non-goals

- Do not expose arbitrary files under `DATA_ROOT`.
- Do not support deletion in the first implementation.
- Do not automatically reload when a file is saved.
- Do not reload unsaved editor drafts.
- Do not restart active turns or agent sessions.
- Do not make JSON Schema validation in the browser authoritative.
- Do not redact source editor content, because editing needs the original file text.

## File Scope

The managed file set is fixed to these paths below `DATA_ROOT/config`:

- `server.jsonc`
- `providers/*.provider.jsonc`
- `agents/*.agent.jsonc`

The protocol-visible `fileId` is the normalized relative path from `DATA_ROOT/config`.

Examples:

```text
server.jsonc
providers/openrouter.provider.jsonc
agents/codex.agent.jsonc
```

Provider and agent creation uses server-owned templates.

The filename component must match `[A-Za-z0-9._-]+`.

Absolute paths, `..`, nested separators inside names, unsupported suffixes, symlink escapes, and paths outside the config root are rejected.

## Protocol Boundary

`docs/app-api.md`, `apps/nanocore`, and `packages/core-client` own the UI-Core admin config surface.

The stable Core protocol intentionally does not copy NanoCore runtime config, Settings, diagnostics, provider config, OAuth, dashboard read models, or internal-agent diagnostics.

After the 2026-05-27 core protocol hardening cleanup, the Settings payloads are App API schemas owned by `apps/nanocore/src/app-api/runtime-config.ts` and parsed by `packages/core-client/src/app-api/runtime-config.ts`, not exports from `@openkit/protocol`.

The App API payloads are:

- `RuntimeConfigFileKind`
- `RuntimeConfigFileSummary`
- `RuntimeConfigFile`
- `RuntimeConfigFileDiagnostic`
- `RuntimeConfigFileListResponse`
- `RuntimeConfigFileReadResponse`
- `RuntimeConfigFileWriteRequest`
- `RuntimeConfigFileWriteResponse`
- `RuntimeConfigValidationRequest`
- `RuntimeConfigValidationResponse`
- `RuntimeConfigSchemaCatalogResponse`

`RuntimeConfigFileDiagnostic.range` uses one-based `startLine`, `startColumn`, `endLine`, and `endColumn` fields so CodeMirror markers can be derived without leaking parser internals.

Reload continues to use App API `RuntimeConfigReloadRequest`, `RuntimeConfigReloadResponse`, and `RuntimeConfigReloadPlan`.

## Admin APIs

The first implementation adds these NanoCore routes:

```text
GET  /api/admin/config/files
GET  /api/admin/config/file?id=<fileId>
POST /api/admin/config/file
PUT  /api/admin/config/file
GET  /api/admin/config/schemas
POST /api/admin/config/validate
POST /api/admin/config/reload
```

The web app consumes them only through `@openkit/core-client`.

No web code reads or writes the filesystem directly.

In local mode, the routes are available through the local trust boundary.

In server mode, the routes use the existing server auth middleware and return the same unauthenticated behavior as other protected app routes.

The routes are not added to public or OpenAI-compatible facade surfaces.

## File Service

`RuntimeConfigFileService` owns filesystem interaction for the admin config APIs.

Responsibilities:

- List allowed config files with stable kind, path, revision, and updated time metadata.
- Read file content exactly as stored on disk.
- Create provider and agent config files from valid JSONC templates.
- Update files only when `expectedRevision` matches the current disk revision.
- Return `409 config_revision_conflict` when the revision does not match.
- Write through a temporary file followed by atomic rename.
- Create `providers/` or `agents/` directories when needed.
- Reject unsupported paths and symlink escapes before reading or writing.

The revision is a SHA-256 hash of the file content.

The service does not delete files.

Templates prefer `secretRef` placeholders over inline raw secret placeholders.

## Validation Pipeline

Startup load, manual reload, saved-file validation, and draft validation share one runtime config pipeline.

The pipeline performs:

1. JSONC parsing.
2. File-kind schema validation.
3. Provider registry merge.
4. Agent config and manifest loading.
5. Cross-file semantic validation.
6. Runtime snapshot construction.
7. Runtime diff against the current active snapshot when a current snapshot exists.

`POST /api/admin/config/validate` can accept draft file overlays.

The overlay is evaluated in a temporary virtual config root and does not mutate disk.

Validation returns diagnostics, the current redacted runtime config status, and a dry-run reload plan.

Saving a single file requires that file to parse as a JSONC object and match its file-kind schema.

Cross-file runtime blocking diagnostics can still be returned to the UI and will block reload if the saved config tree is not valid.

`POST /api/admin/config/reload` always reads disk state.

It never applies unsaved drafts.

## Editor Design

Settings adds a `Runtime config` section separate from the workspace `Configuration` section.

The layout is:

- Left: file tree grouped by Server, Providers, and Agents.
- Center: CodeMirror source editor with JSONC-oriented behavior and a textarea fallback for tests.
- Right: diagnostics, schema hints, and raw-secret-shaped source warnings.
- Bottom or inline actions: Save, Validate, Discard changes, Reload file from disk, Dry run reload, and Reload.

The editor uses CodeMirror 6 directly without a React or Solid wrapper.

The first implementation uses CodeMirror language, lint, search, autocomplete, bracket matching, and save shortcut support.

NanoCore diagnostics are mapped into CodeMirror lint diagnostics.

The browser may use schema catalog information for hints and side-panel documentation, but NanoCore validation remains authoritative.

If JSONC-specific highlighting is incomplete, the source format does not change.

## Save and Conflict Workflow

Read responses include both source content and the current file revision.

Update requests must include `expectedRevision`.

If the server revision differs, NanoCore rejects the save with `409 config_revision_conflict`.

The UI keeps the local draft intact, surfaces the conflict, and offers reload-from-disk rather than overwriting automatically.

Users can manually keep their draft elsewhere or reload the file from disk before retrying.

Save does not imply reload.

After a successful save, the UI refreshes file summaries, the selected file, setup diagnostics, and app diagnostics.

## Reload Workflow

Reload is disabled while the selected editor draft has unsaved changes.

Dry-run reload calls the existing reload endpoint with `dryRun: true`.

Apply reload calls the same endpoint with `dryRun: false`.

`safe` is the default mode.

`strict` rejects reload only when actual changed values contain restart-required items.

The UI displays applied, deferred, restart-required, rejected, and warning counts without implying restart-required changes are live.

After reload, the UI refreshes runtime status, setup diagnostics, app diagnostics, and the selected thread dashboard.

Active turns and active agent sessions are not interrupted.

Stale active sessions remain visible through diagnostics and thread dashboard state.

## Security and Redaction

Diagnostics and reload responses must remain redacted.

`@openkit/app-api-schemas` rejects raw-secret-shaped strings from setup diagnostics, runtime config reload responses, and runtime config validation responses before NanoCore or the client can render them.

File read responses intentionally carry raw source content and are not subject to that rejection path.

The source editor warns when raw-secret-shaped strings appear, but it does not redact the editor text.

Operators should use `secretRef` values for provider credentials.

## Alternatives Considered

### Plain textarea

A plain textarea would preserve source text with the lowest dependency cost.

It was rejected because the runtime config workflow benefits from search, brackets, syntax presentation, keyboard save, and inline diagnostics.

### Monaco

Monaco provides a mature JSON editor and schema experience.

It was rejected for the first implementation because it is larger, worker-heavy, and less natural for the current Vite/Solid test surface than CodeMirror.

### Browser-authoritative JSON Schema validation

The UI could run a JSON Schema validator locally.

It was rejected as a critical path because NanoCore already owns JSONC parsing, Zod schema parsing, provider merge rules, semantic validation, and reload diffing.

The schema catalog remains useful for hints, documentation, and future autocomplete.

## Testing Strategy

Core-client and NanoCore tests cover the admin config wrapper payloads.

Core-client tests cover endpoint paths, response validation, reload redaction, and source-file read behavior.

NanoCore tests cover file scope, path rejection, create templates, revision conflict, draft overlay validation, reload interaction, and auth protection.

Web tests cover rendering the Settings section, file selection, source editing, validation, save behavior, revision conflict display, dry-run reload calls, reload disabling while dirty, and stale session markers.

## Risks & Mitigations

Risk: A browser draft overwrites a disk change from another editor.

Mitigation: require `expectedRevision` and return `409 config_revision_conflict`.

Risk: Config file editing exposes raw secrets.

Mitigation: restrict routes to local or authenticated server mode, avoid exposing them publicly, warn in UI, and keep diagnostics redacted.

Risk: Browser-side schema hints drift from NanoCore validation.

Mitigation: treat the schema catalog as advisory and keep NanoCore validation authoritative.

Risk: Reload applies config that active sessions cannot safely adopt.

Mitigation: preserve snapshot capture for accepted turns and active sessions, mark stale sessions, and do not auto-restart.

Risk: The UI implies restart-required changes are active.

Mitigation: show restart-required changes as pending and do not label them as applied.

## Links

- `docs/specs/20260525-runtime_config_reload.md`
- `apps/nanocore/src/app-api/runtime-config.ts`
- `packages/core-client/src/app-api/runtime-config.ts`
- `packages/core-client/src/client.ts`
- `apps/nanocore/src/config/runtime-config-files.ts`
- `apps/web/src/components/RuntimeConfigPanel.tsx`
