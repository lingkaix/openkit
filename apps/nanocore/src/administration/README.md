# Private Administration Entry

This directory owns the private administration conversation entry and its fixed model-visible Tool assembly. It reuses the shared Internal Agent Loop and existing Core operation owners; it does not own configuration, Worker environment, approval, authentication, or storage effects.

## Boundaries

- Admit only the current user's `administration` Thread in that user's owner-only Quick Chat Workspace.
- Recheck current deployment-administrator authority at entry and before every Tool closure. The model never receives token material.
- Keep the exact Tool order in `administration-tools.ts`. Configuration read and schema Tools expose only the registered Server Agent family. Read supports discovery without an Agent ID and returns exact file identities and revisions for preparation; detail reads expose a redacted Agent runtime; configuration proposal returns a typed unavailable result until its immutable candidate owner exists.
- Environment Tools are injected from their operation owner and remain list, status, and prepare only. Preparation uses the actual current administration Turn and the shared immutable Agent configuration candidate service; it validates the exact file revision and publishes authored/resolved Artifacts without applying them. Activation and purge stay on human-confirmed public commands.
- Persist ordinary Turn and Item records. Do not introduce a private run ledger, Worker lease, shell, Docker socket, or arbitrary MCP/Skill surface.

## Verification

Run the focused administration tests together with `internal-agent-loop.test.ts` and `gateway-provider.test.ts`, then the NanoCore package checks described in the [source guide](../README.md).
