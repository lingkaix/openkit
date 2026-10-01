# Config Schema

`@openkit/config-schema` is the shared source of truth for OpenKit authored config schemas, policy metadata, JSON Schema catalog entries, workspace root materialization helpers, and session workspace layout planning schemas.

Provider profiles retain string model IDs and may add a per-ID `modelMetadata` map using the models.dev operational field names. Its strict schema and native-ID membership checks feed the existing configuration validation and generated JSON Schema; the Gateway and backend owners define inheritance and actual runtime use.

Provider model declarations require an effective positive maximum context length, inherited from the pinned model catalog or explicitly authored as `modelMetadata[modelId].limit.context`. Other metadata remains optional. Structural validation admits omission for catalog inheritance; composed validation must reject a model with no known context before replacing active configuration.

Every Gateway logical model declares one OpenKit-owned `contextManagement` compaction policy. NanoCore validates its threshold and output reserve against every authored route, including routes whose Provider is currently disabled; runtime consumers fail closed when compaction is required but no durable OpenKit compaction adapter is available.

NanoCore consumes this package so runtime loading, draft validation, reload planning, and UI schema hints follow one contract instead of copying rules into routes or UI components.

The required-feature registry includes `openkit.thread-entry.v1` for file-backed Thread records carrying the immutable server-authored conversation or administration entry path. Readers must name support before accepting those records.

Worker sandbox filesystem grants must use canonical absolute paths. Authored read-write grants cannot equal, descend from, or contain any fixed read-only image root; read-only grants and writable paths beneath `/workspace` or `/sandbox` remain valid.

Authored and resolved build images require exactly one nonempty inline Dockerfile of 1 through 268,435,456 UTF-8 bytes with matching canonical lowercase SHA-256, independently of exact zero-entry `build-context://empty/v1` plus its empty-byte digest, with no locator or compatibility form.

Authored and resolved build-argument checks share only the stateless secret-shape pattern in the package-internal `src/build-argument-pattern.ts`; their schema definitions and refinements remain separate. The pattern is not exported by `src/index.ts`, and the browser-safe App API projection retains its separate pattern.

The closed provider-subscription identities admit only `openai-codex` and `xai`, with bounded account-slot identifiers. Authored OAuth profiles in either normalized family must bind one explicit `extensions.openkit.subscriptionAccount.accountSlotId` and omit `secretRef` and `baseUrl`; other OpenKit extension fields are rejected, while ordinary non-OAuth xAI profiles remain direct provider configurations.

`@openkit/config-schema/provider-subscription` is the browser-safe entry point for provider-subscription identifiers and account-slot schemas. Browser consumers use this subpath instead of the package root, whose complete config surface intentionally includes server-only modules.

Worker control has one canonical shape: the URL-free sandbox-local Integration binding with a non-secret token reference, required transcript sink, and exact `worker-control` backend capability. Legacy direct-NanoCore, sidecar, relay, stdio, and disabled-control shapes are rejected. Worker capabilities use a separate token reference and enable only `mcp.list_servers`, `mcp.list_tools`, and `mcp.call_tool` when selected MCP supply is non-empty; packages without selected MCP supply remain explicitly disabled.

Relay-required Agent Environment Packages use the `trusted-worker-inference-relay` capability. The version 4 package requires one OpenAI-compatible NanoCore Gateway route, placeholder credential visibility, and no `providers` section, `workerBaseUrl`, native URL, direct inference credential, or provider-backed MCP supply. Runtime credential declarations remain secret-free references in the package and are materialized only by the backend effect path.

Agent Environment Packages may require `worker.runtime-provenance.v1` only together with `trusted-worker-inference-relay`. That feature requires the fixed restricted raw-stream root, stream manifest path, native-origin index path, and positive byte and stream-count limits beneath `/openkit/session`; NanoCore projects those declarations only when the feature is explicitly requested. The current NanoHost capability declaration does not advertise `worker.runtime-provenance.v1`, so packages that require it fail closed during package validation rather than selecting a legacy runtime path.

An AEP LLM route may carry strict `modelParameters` containing positive integer `contextWindow` and `maxOutputTokens`, canonical `inputModalities` and an explicit `reasoning` boolean. All four fields are required when the object is present; omitted parameters remain absent for retained packages and adapters that do not require them. This projection carries no Provider identity, pricing or credentials.

`server.ts` owns `server.jsonc`: unknown top-level optional keys are stripped with NanoCore warnings, while known fields and all nested authority sections remain strict. This includes the optional absolute `vault.encryptedFile.keyFilePath` and the secret-free NanoHost configuration containing `identityId`, `deploymentId`, dedicated `bind`, `rendezvousUrl`, `credentialRef`, and fixed A/B `secretPath` plus `companionPath` pairs. `server.bind` belongs only to the App HTTP/1.1 and SSE listener; the required NanoHost bind belongs to its separate native HTTP/2 listener. NanoCore owns key-file permissions, ownership, bounded loading, authentication, boot behavior, and safe use of the configured NanoHost credential paths.

Authored configuration is split by owner: Server resource and fallback files (`server.jsonc`, `gateway.jsonc`, internal-role profiles, Providers, and Agent Manifests), shared Workspace composition (`workspace.jsonc`, data-source catalogs, and the Workspace resource catalog at `catalog/catalog.json`), and lightweight User preferences (`user.jsonc`). Explicit request or Orchestrator selection is most specific, followed by User, Workspace, and Server defaults. Workspace MCP catalogs keep transport topology and Vault grant bindings server-side; AEP supply receives only the selected id, catalog digest, tool rules, approval marks, and schema policy. Workspace configuration owns its name, default Agent, Agent and internal-role bindings, roots, Assistant repository inspection, and extensions; `workspace-record.json` remains the machine-owned record.

The hand-written `server.jsonc`, `user.jsonc`, and `workspace.jsonc` schemas admit top-level `requiredFeatures`; no feature is currently supported by these readers, so every declared feature fails closed after registry classification. User preference objects and Workspace internal-role preferences strip unknown optional keys. Workspace composition and Server authority sections remain strict. NanoCore reports ignored keys and their JSON locations without including values.

NanoCore-created linked-repository roots add a full `sourceCommit` object id before AEP projection. The AEP source, durable input snapshot, and materialization record preserve that exact base so worker change manifests cannot substitute a different repository lineage.

The session workspace planner consumes the pure Worker protocol path projection to bind Context inputs to `/openkit/sessions/<agent-session-id>/context`; authored filesystem grants cannot select this Core-managed namespace.

Optional `server.jsonc.appUpdate` fixes one SSH host, user, port, identity file and known-hosts file. It is deployment configuration requiring App restart, not a Workspace capability or editable request destination. NanoCore checks that the protected files remain outside Data Root; host installation owns the forced command and fixed deployment target.

[`src/tree-digest.ts`](src/tree-digest.ts) owns openkit-tree-v1 framing and validation; its path ordering uses unsigned UTF-8 byte comparison through Node Buffer.compare, not locale or UTF-16 ordering.

AEP `observability.captureCoverage` uses the shared Worker protocol schema as a required admission-bound pair without a default. Runtime construction reads the persisted Turn setting; the shim never resolves configuration precedence. `openkit.work-observations.v1` registers the observation family for explicit reader support and portable reference handling, independently of optional full runtime provenance.

## Commands

- `pnpm --filter @openkit/config-schema test`
- `pnpm --filter @openkit/config-schema typecheck`
- `pnpm --filter @openkit/config-schema build`

`model-catalog.jsonc` uses `ModelCatalogSchema` for deployment-admin model metadata extensions keyed by exact vendor (or profile ID without vendor) and native model ID. The generated editor and policy catalogs include its `model-catalog` kind; effective precedence is snapshot, extension, then profile, with restart-required activation.

`openkit.thread-visibility.v1` gates explicit Thread audience and private-owner semantics in canonical record envelopes.

`server.jsonc.policy.workspaceApprovalModes` maps exact Workspace IDs to strict per-action modes for `repo.push`: `require_human_approval` or `auto_allow`. Missing entries require human approval. The policy catalog marks this deployment-owned setting restart-required and forbids request or Workspace overrides.

Exact REST network grants may carry the closed `publicAccess: { kind: 'credential-free-non-llm' }` admission marker. Presets and unsupported marker semantics fail closed. Resolved AEP policy preserves the marker as immutable evidence; NanoCore owns current classification, while OpenShell receives only the existing exact network tuple. See the accepted public-route decision and Agent Manifest And AEP Resolution owner when integrating the frozen communication redesign amendments.

## Public Native Environment

Server Agent `runtime.environment` is a bounded literal string/null override map. Omission inherits confirmed image defaults, an empty string remains a value, and null suppresses a default. The resolved AEP carries `{ imageDigest, defaultsDigest, values }`; protected bootstrap and adapter names are managed, and runtime credential names cannot collide. Inert additions to the affected runtime/package cores are discarded; unsupported authority and required semantics fail closed. The shared literal validators preserve legal prototype-looking variable names rather than silently dropping them.

Authored Agent runtime readers discard unknown optional envelope metadata regardless of its name, while preserving the declared runtime exclusions and protected-name checks. NanoCore reports ignored runtime keys through its existing located configuration warnings; environment variable names are consumed literal settings, not envelope metadata.

Authored `runtime.environment` uses the worker-protocol protected-name predicate, including Codex retained-state bindings. Overrides and null removals fail with `Native environment name is managed.` Harmless `OPENAI_` settings remain admissible; a vendor prefix alone supplies no authority.
