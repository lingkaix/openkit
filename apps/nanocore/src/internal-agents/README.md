# Internal Core Roles

This directory owns the deterministic Workflow Coordinator, Internal Role Execution Profile resolution, the bounded shared Internal Agent Loop, structured worker delegation payloads, and shared redaction helpers used by NanoCore services.

## Boundaries

- Keep Coordinator decisions request-scoped and deterministic; mode services own persistence and effects.
- Assemble a fixed ordered Tool set before each Internal Agent Loop run. The loop validates Tool arguments, executes only its injected closures, preserves correlated transcript order, and terminates through explicit model-turn, Tool-call, cancellation, or deadline fuses.
- Bind the loop to logical-model dispatch through `gateway-provider.ts`; role entry owners retain authorization, durable Item production, usage attribution, and product-success interpretation.
- Resolve internal-role profile preference User first, then Workspace, then Server, and admit only logical models whose derived capabilities satisfy the profile.
- Keep worker delegation schemas here because they are the concrete handoff from mode decisions to worker execution.
- Configured product and worker agents belong to `../agents/`; governed worker execution and recovery belong to `../runtime/`.
- Ordinary Quick Chat provider behavior remains in `../mode-entry-routes.ts`; do not introduce a registry, hook system, private event protocol, or streaming facade here.
- Keep shared redaction helpers free of workflow or diagnostics ownership.

## Verification

Run `internal-agent-loop.test.ts`, `gateway-provider.test.ts`, `profile-resolver.test.ts`, and the focused entry or Coordinator tests affected by the change, followed by the package gates in the [NanoCore source guide](../README.md).
