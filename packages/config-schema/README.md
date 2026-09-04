# Config Schema

`@openkit/config-schema` is the shared source of truth for OpenKit authored config schemas, policy metadata, JSON Schema catalog entries, workspace root materialization helpers, and session workspace layout planning schemas.

NanoCore consumes this package so runtime loading, draft validation, reload planning, and UI schema hints follow one contract instead of copying rules into routes or UI components.

Authored and resolved build images require exactly one nonempty inline Dockerfile of 1 through 268,435,456 UTF-8 bytes with matching canonical lowercase SHA-256, independently of exact zero-entry `build-context://empty/v1` plus its empty-byte digest, with no locator or compatibility form.

The closed provider-subscription identities admit only `openai-codex` and `xai`, with bounded account-slot identifiers. Authored OAuth profiles in either normalized family must bind one explicit `extensions.openkit.subscriptionAccount.accountSlotId` and omit `secretRef` and `baseUrl`; other OpenKit extension fields are rejected, while ordinary non-OAuth xAI profiles remain direct provider configurations.

`@openkit/config-schema/provider-subscription` is the browser-safe entry point for provider-subscription identifiers and account-slot schemas. Browser consumers use this subpath instead of the package root, whose complete config surface intentionally includes server-only modules.

Worker control has one canonical shape: the URL-free sandbox-local Integration binding with a non-secret token reference, required transcript sink, and exact `worker-control` backend capability. Legacy direct-NanoCore, sidecar, relay, stdio, and disabled-control shapes are rejected. Worker capabilities use a separate token reference and enable only `mcp.list_servers`, `mcp.list_tools`, and `mcp.call_tool` when selected MCP supply is non-empty; packages without selected MCP supply remain explicitly disabled.

Relay-required Agent Environment Packages use the `trusted-worker-inference-relay` capability. The version 4 package requires one OpenAI-compatible NanoCore Gateway route, placeholder credential visibility, and no `providers` section, `workerBaseUrl`, native URL, direct inference credential, or provider-backed MCP supply. Runtime credential declarations remain secret-free references in the package and are materialized only by the backend effect path.

Agent Environment Packages may require `worker.runtime-provenance.v1` only together with `trusted-worker-inference-relay`. That feature requires the fixed restricted raw-stream root, stream manifest path, native-origin index path, and positive byte and stream-count limits beneath `/openkit/session`; NanoCore projects those declarations only when the feature is explicitly requested. The current NanoHost capability declaration does not advertise `worker.runtime-provenance.v1`, so packages that require it fail closed during package validation rather than selecting a legacy runtime path.

`server.ts` owns the strict `server.jsonc` shape, including the optional absolute `vault.encryptedFile.keyFilePath` and the secret-free NanoHost configuration containing `identityId`, `deploymentId`, dedicated `bind`, `rendezvousUrl`, `credentialRef`, and fixed A/B `secretPath` plus `companionPath` pairs. `server.bind` belongs only to the App HTTP/1.1 and SSE listener; the required NanoHost bind belongs to its separate native HTTP/2 listener. NanoCore owns key-file permissions, ownership, bounded loading, authentication, boot behavior, and safe use of the configured NanoHost credential paths.

Authored configuration is split by owner: Server resource and fallback files (`server.jsonc`, `gateway.jsonc`, internal-role profiles, Providers, and Agent Manifests), shared Workspace composition (`workspace.jsonc`, data-source catalogs, and MCP server catalogs), and lightweight User preferences (`user.jsonc`). Explicit request or Orchestrator selection is most specific, followed by User, Workspace, and Server defaults. Workspace MCP catalogs keep transport topology and Vault grant bindings server-side; AEP supply receives only the selected id, catalog digest, tool rules, approval marks, and schema policy. Workspace configuration owns its name, default Agent, Agent and internal-role bindings, roots, Assistant repository inspection, and extensions; `workspace-record.json` remains the machine-owned record.

NanoCore-created linked-repository roots add a full `sourceCommit` object id before AEP projection. The AEP source, durable input snapshot, and materialization record preserve that exact base so worker change manifests cannot substitute a different repository lineage.

## Commands

- `pnpm --filter @openkit/config-schema test`
- `pnpm --filter @openkit/config-schema typecheck`
- `pnpm --filter @openkit/config-schema build`
