# Private Administration Entry

This directory owns the private administration conversation entry and its fixed model-visible Tool assembly. It reuses the shared Internal Agent Loop and existing Core operation owners; it does not own configuration, Worker environment, approval, authentication, or storage effects.

## Boundaries

- Admit only the current user's `administration` Thread in that user's owner-only Quick Chat Workspace.
- Recheck current deployment-administrator authority at entry and before every Tool closure. The model never receives token material.
- Keep the exact Tool order in `administration-tools.ts`. Configuration read and schema Tools expose the registered Server Agent family and editable Provider/Gateway catalog fields. Agent discovery returns exact file identities and revisions for image preparation. Catalog discovery returns target identities and source revisions; proposals publish an immutable, non-secret before/after Artifact through `../config/administration-configuration.ts`.
- Environment Tools are injected from their operation owner and remain list, status, and prepare only. Preparation uses the actual current administration Turn and the shared immutable Agent configuration candidate service; it validates the exact file revision and publishes authored/resolved Artifacts without applying them. Activation and purge stay on human-confirmed public commands. Catalog application uses `POST /api/app/administration/configuration/apply` after human review of the exact candidate digest; it is never a model Tool.
- The six-Tool prompt states that NanoHost is the execution host, not an LLM Provider. This entry cannot observe RuntimeTarget readiness and must not infer unreadiness from Provider catalog or Worker environment absence; authorized operators use the existing public `nanohost.runtime-target` observation.
- Persist ordinary Turn and Item records. Do not introduce a private run ledger, Worker lease, shell, Docker socket, or arbitrary MCP/Skill surface.

## Verification

Run the focused administration tests together with `internal-agent-loop.test.ts` and `gateway-provider.test.ts`, then the NanoCore package checks described in the [source guide](../README.md).
