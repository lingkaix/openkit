# Worker Environment Operations

This directory owns the bounded App API and in-process administration operations for retained Worker environments. It projects Core-owned `WorkerStorageBinding` records and delegates fixed host observations and effects to `WorkerEnvironmentRuntimeEffects`.

Every operation rechecks the initiating user's current usable deployment-administrator authority and current target Workspace policy. Until durable Thread visibility is implemented, source-audience admission fails closed unless every contributor belongs to the current user and its source Thread still exists in the same Workspace.

The surface never exposes host paths, native runtime handles, credentials, or retained file contents. Selection only validates an explicit future-work choice; ordinary Task and Goal admission remains the runtime scheduler's owner. Purge checks unfinished Goal and queued, denied or nonterminal admitted work before reserving an idle association through Core revision compare-and-set, delegates the fixed whole-ref effect, and records a definite purged, retained, or truthful unknown settlement under the existing command receipt owner. Missing reference authority prevents deletion.

Preparation creates separate immutable authored and resolved Artifact version 1 records on a private administration Turn before and after exact image settlement. Preparation and activation use global routes, while storage list, select, status and purge remain Workspace-scoped. Preparation returns the canonical activation confirmation for human review. Activation consumes only the resolved Artifact and exact Agent file SHA, target, successor prompt and storage revision confirmation, applies the existing configuration CAS and safe reload, then delegates writer fencing and replacement to the ordinary interrupt and scheduler owners. Its private Turn retains the exact partial response in one immutable Artifact; command replay reads that response without repeating effects. Explicit preparation recovery uses a fresh causation Turn and reads only the original retained image result.

An exact local image digest still performs `image.acquire` and has an ordinary durable image-effect result. Recovery must recover that result before read-only inspection and candidate publication; it never treats the old preload assumption as proof or replays acquisition.

Run focused checks with `pnpm --dir apps/nanocore exec vitest run src/worker-environments` and `pnpm --dir apps/nanocore typecheck`.
