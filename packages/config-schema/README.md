# Config Schema

`@openkit/config-schema` is the shared source of truth for OpenKit authored config schemas, policy metadata, JSON Schema catalog entries, workspace root materialization helpers, and session workspace layout planning schemas.

NanoCore consumes this package so runtime loading, draft validation, reload planning, and UI schema hints follow one contract instead of copying rules into routes or UI components.

Worker control has one canonical shape: `direct-nanocore` over an HTTP(S) `/api/worker-control` endpoint, an environment-visible sandbox session authentication grant, a required transcript sink, and an adapter transport that matches the endpoint scheme exactly. Backends advertise this path with `worker-control`; legacy sidecar, relay, stdio, disabled-control, and local capability endpoint shapes are not accepted. The separate worker-capability plane remains explicitly disabled until NanoCore owns a real direct implementation.

Relay-required Agent Environment Packages use the `trusted-worker-inference-relay` capability. The canonical schema requires one OpenAI-compatible NanoCore gateway route, placeholder credential visibility, an exact HTTP(S) `/api/worker-inference/v1` base URL, a matching secret-free gateway provider/model, exact relay-only Codex POST network policy, and no direct credential, vault, provider attachment, or provider-backed MCP supply.

Agent Environment Packages may require `worker.runtime-provenance.v1` only together with `trusted-worker-inference-relay`. That feature requires the fixed restricted raw-stream root, stream manifest path, native-origin index path, and positive byte and stream-count limits beneath `/openkit/session`; NanoCore projects those declarations only when the feature is explicitly requested, and production backends do not advertise it until the same-target executable and cross-surface conformance gates pass.

`server.ts` owns the strict `server.jsonc` shape, including the optional absolute `vault.encryptedFile.keyFilePath`; NanoCore owns key-file permissions, ownership, bounded loading, authentication, and boot behavior.

Workspace config currently covers `workspace.roots` and `workspace.assistant.repositoryInspection`. The Assistant repository inspection policy defaults to enabled and lets a workspace disable Chat Mode repository reads or exclude exact repository-relative path prefixes without changing worker roots.

NanoCore-created linked-repository roots add a full `sourceCommit` object id before AEP projection. The AEP source, durable input snapshot, and materialization record preserve that exact base so worker change manifests cannot substitute a different repository lineage.

## Commands

- `pnpm --filter @openkit/config-schema test`
- `pnpm --filter @openkit/config-schema typecheck`
- `pnpm --filter @openkit/config-schema build`
