# @openkit/mcp (Pending Removal)

`@openkit/mcp` is the legacy user-facing stdio MCP channel currently present in the repository. It is no longer a current product direction and will be deleted without a compatibility server, proxy, alias, package redirect, resource bridge, or tool-name preservation.

The canonical replacement is one end-user `openkit` Skill with a bundled, progressively disclosed CLI. Read [`docs/specs/20260713-openkit_agent_skill_interface.md`](../docs/specs/20260713-openkit_agent_skill_interface.md) for the accepted contract and [`docs/changes/202607131935040001-openkit_agent_skill_interface.md`](../docs/changes/202607131935040001-openkit_agent_skill_interface.md) for the implementation and removal plan.

## Transitional Rules

- Do not add tools, resources, prompts, setup paths, configuration options, consumers, compatibility behavior, or documentation to this package.
- Preserve only the minimum existing behavior and tests needed to verify capability parity while the transport-neutral operation catalog and bundled CLI are implemented.
- Map every supported public end-user and operator capability to the new operation catalog or a machine-checked exclusion before deletion.
- Delete this package, its binary, stdio transport, MCP configuration, MCP-only tests, smoke harnesses, and package references in the removal stage.
- Treat all setup instructions for desktop MCP clients as historical implementation details, not supported future guidance.

## Boundary

This removal applies only to the user-facing `@openkit/mcp` product channel. Worker-side MCP capability supply is a separate accepted future design governed by [`docs/specs/20260704-worker_mcp_tool_supply.md`](../docs/specs/20260704-worker_mcp_tool_supply.md). It is not currently implemented: worker Agent Environment Packages declare `capabilities.mode: disabled`, and no worker capability routes are exposed.

## Temporary Verification

Until deletion, the existing package checks may be used only for parity and removal safety:

```bash
pnpm --filter @openkit/mcp test
pnpm --filter @openkit/mcp typecheck
pnpm --filter @openkit/mcp build
pnpm --filter @openkit/mcp smoke:nanocore
```

New acceptance coverage belongs to the unified Skill and CLI path defined by the replacement spec.
