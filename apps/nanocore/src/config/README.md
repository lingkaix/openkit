# Configuration

This directory owns NanoCore-specific configuration discovery, loading, precedence, runtime snapshots, reload behavior, and configuration routes.

## Boundaries

- Keep environment, mode, bind-host, data-root, server, workspace, agent, and provider configuration loading here.
- Load Server resources and fallbacks, shared Workspace composition, and User preferences as distinct owners; resolve explicit selection, User, Workspace, then Server without treating Server supply as a Workspace ceiling.
- Keep `gateway.jsonc`, `internal-role-profiles.jsonc`, `providers/*.provider.jsonc`, `agents/*.agent.jsonc`, `workspaces/*/config/workspace.jsonc`, `workspaces/*/config/data-sources.jsonc`, `workspaces/*/catalog/catalog.json`, and `users/*/config/user.jsonc` distinct in snapshots and diagnostics.
- Accept only configuration that has a current runtime consumer; bind, CORS, public URL, sign-up, and gateway policy are startup-owned. Ignored optional Server, User, Workspace preference, data-source and Agent runtime envelope keys produce located warnings through the existing loader, snapshot and file-validation diagnostics; environment variable names remain consumed settings; unknown authority-section keys and unsupported required features still fail closed.
- Cross-package contract schemas remain in their owning packages; this directory performs NanoCore-specific file I/O and runtime projection.
- `../agents/` and `../providers/` own resolved runtime concepts after loading, so configuration code must not introduce parallel registries.
- Secret values must remain behind explicit references or backend-private state and must not enter snapshots, diagnostics, or generated configuration.
- New Agent config templates must name the immutable image-owned Python environment under `/opt/openkit/venv`; writable user-created environments remain runtime data and are not default template authority.
- New Agent files created without supplied content select `openkit/worker-runtimes:dev` with the Codex adapter and its image pin `0.159.2`, prefer the `smart` logical tier, and allow `all` configured logical models; creation does not rewrite existing authored files.
- MCP catalog changes are session-scoped; stdio enablement requires deployment-admin. Catalog App API mutations reload the runtime snapshot and close Gateway sessions for that Workspace.
- A failed reload must not publish a partially updated runtime snapshot.
- Reload failure diagnostics must redact the concrete data root. Accepted Workspace-name changes refresh the joined store projection immediately; session-scoped Agent changes apply to later composition, while startup-captured Provider changes remain restart-required.

## Verification

Run the focused loader, precedence, runtime snapshot, reload, file, and route tests affected by the change, followed by the package gates in the [NanoCore source guide](../README.md).

`administration-configuration.ts` projects existing Provider catalog metadata and Gateway logical-model bindings into immutable private candidate Artifacts. It preserves credential/endpoint/extension fields, validates source revisions and dependencies, and reuses the file service for application. Human application records a start Item before effects and an immutable outcome plus command receipt afterward; interrupted effects require inspection rather than automatic retry. Provider changes may remain restart-required.

`model-catalog.ts` loads strict `config/model-catalog.jsonc` and projects its exact vendor/native-ID entries beneath profile overlays, leaving both authored files unchanged. The runtime snapshot tracks the complete catalog, including unused entries, and retains active catalog and Provider metadata until restart. Generic file operations expose the `model-catalog` kind under the existing deployment-admin boundary.

`server.jsonc.policy.workspaceApprovalModes` is startup-owned deployment policy keyed by exact Workspace ID and action. Changes require restart; Workspace files and request data cannot override it.

`server.jsonc.policy.workDataCapture` is the default-off work-data capture switch. Its resolved value is fixed at Turn admission, so a change is applied at the next Turn and never interrupts a running Turn; unlike `workspaceApprovalModes`, it does not require restart.

## Public Native Environment

`agent-native-environment.ts` derives the administrator view from confirmed image settlements, the existing Agent file revision, the live configuration snapshot and audience-checked AgentSession bindings. Updates use `RuntimeConfigFileService.updateFile` CAS and safe reload; failed reload keeps the previous snapshot. Native application is pending until exact native-start acknowledgement, and uncertain or cleanup-unproved bindings expose unknown state without applied values.

Gateway reload warns for unavailable authored members without rejecting their logical IDs. Invalid thresholds remain blocking. Account integrity failures make only the bound members unavailable, while the account owner retains strict integrity errors. Pre-owner boot snapshots do not evaluate subscription availability. Unknown additive keys inside `logicalModels[*].routing` are stripped and receive located warnings through snapshot and file validation; `autoFailover` must be a boolean when routing is present.

Provider and extension `reasoning_options` use the shared strict metadata schema. The existing leaf overlay replaces option arrays, preserving explicit empty arrays and restoring extension inheritance when a profile leaf is removed. Safe reload retains active options until restart; invalid candidates retain the last-known-good metadata.

`RuntimeConfigFileService.deleteFile` removes only an exact Provider profile under the same containment and revision checks as writes. Its deployment-admin DELETE command requires a non-null existing revision. Key profiles revoke their exact server Vault key through the provider credential owner before unlinking; subscription profiles leave shared account slots untouched. Failed effects are reported without rollback or replay. References remain authored, safe reload retains the active registry with pending restart, and strict reload rejects the restart-required candidate.
