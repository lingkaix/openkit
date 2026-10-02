# Private Administration Entry

This directory owns the private administration conversation entry and its fixed model-visible Tool assembly. It reuses the shared Internal Agent Loop and existing Core operation owners; it does not own configuration, Worker environment, approval, authentication, or storage effects.

## Boundaries

- Admit only the current user's `administration` Thread in that user's owner-only Quick Chat Workspace.
- Recheck current deployment-administrator authority at entry and before every Tool closure. The model never receives token material.
- Keep the exact Tool order in `administration-tools.ts`. Configuration read and schema Tools expose the registered Server Agent family and editable Provider/Gateway catalog fields. Agent discovery returns exact file identities and revisions for image preparation. Catalog discovery returns target identities and source revisions; proposals publish an immutable, non-secret before/after Artifact through `../config/administration-configuration.ts`.
- Assemble the fixed administration role text from `../internal-agents/builtin-prompts.ts` with current server-authored private Workspace and Thread identifiers for each run. Tool definitions remain the exact entry-owned set and are passed separately to the shared loop.
- Pass that same assembled prompt and ordered Tool set to `withTurnModelCapture` before the loop. Its Core `env.bound` observation retains package version, Workspace identity, prompt digest and Tool name/input-schema digests even with full I/O capture off; prompt text, schemas and descriptions stay out of the row. Required retention failure stops the run through the existing administration failure path.
- Environment Tools are injected from their operation owner and remain list, status, and prepare only. Preparation uses the actual current administration Turn and the shared immutable Agent configuration candidate service; it validates the exact file revision and publishes authored/resolved Artifacts without applying them. Activation and purge stay on human-confirmed public commands. Catalog application uses `POST /api/app/administration/configuration/apply` after human review of the exact candidate digest; it is never a model Tool.
- `nanohost.runtime-target` is the seventh fixed Tool. It reuses `readConfiguredNanoHostRuntimeTargetStatus` with the public GET, accepts only an empty object, and never infers unreadiness from Provider catalog or Worker environment absence. The result is Core's stored projection at `observedAt`, not a live host probe. NanoHost is the execution host, not an LLM Provider.
- Persist ordinary Turn and Item records. Do not introduce a private run ledger, Worker lease, shell, Docker socket, or arbitrary MCP/Skill surface.

The configured RuntimeTarget Tool derives its descriptor from the shared administration operation table and executes through `../operation-invocation.ts`. Invocation rechecks current deployment-administrator authority on every call; the other six Tools retain their existing closure check. The actual assembly supplies authenticated actor and private Workspace/Thread/Turn lineage, returned in non-secret Tool details. `operation-invocation.test.ts` proves that provenance and next-call revocation through the seventh assembled Tool.

## Verification

Run the focused administration tests together with `internal-agent-loop.test.ts` and `gateway-provider.test.ts`, then the NanoCore package checks described in the [source guide](../README.md).
