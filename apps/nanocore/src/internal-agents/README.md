# Internal Core Roles

This directory owns the deterministic Workflow Coordinator, Internal Role Execution Profile resolution, structured worker delegation payloads, and shared redaction helpers used by NanoCore services.

## Boundaries

- Keep Coordinator decisions request-scoped and deterministic; mode services own persistence and effects.
- Resolve internal-role profile preference User first, then Workspace, then Server, and admit only logical models whose derived capabilities satisfy the profile.
- Keep worker delegation schemas here because they are the concrete handoff from mode decisions to worker execution.
- Configured product and worker agents belong to `../agents/`; governed worker execution and recovery belong to `../runtime/`.
- The direct Quick Chat provider call belongs to `../mode-entry-routes.ts`; do not introduce a generic runner, registry, hook system, private event protocol, or streaming facade here.
- Keep shared redaction helpers free of workflow or diagnostics ownership.

## Verification

Run `profile-resolver.test.ts` plus the focused delegation, Quick Chat, and worker-coordinator tests affected by the change, followed by the package gates in the [NanoCore source guide](../README.md).
