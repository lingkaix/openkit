---
type: change-plan
status: in-progress
date: 2026-10-16
---
# Native Generative Sources And Browser Proof

## Intent Revision 1

Source: L-GO P21 dispatch on 2026-10-16. Complete native source admission, generated-answer shorthand, fixed internal Kernel/UI Tool projection, source/presentation grouping, semantic discovery evidence, and local native Worker/browser proof. Reuse the accepted Generative owners and existing native invocation, Item, command receipt and storage paths. Preserve the gates for richer queries, destructive operations, HTML delegates and saved views. Local tests are authorized; real a1 acceptance belongs to L-OPS.

## Owners And Boundaries

[Generative Apps](../../core/generative-apps.md), [Kernel](../../specs/20260908-generative_kernel_data_operations.md), [Generative UI](../../specs/20260908-generative_ui_interaction.md), and [Internal Agent Resource Integration](../../specs/20260909-internal_agent_resource_integration.md) own the behavior. [Core Protocol](../../core/protocol.md#ids) owns identifier encoding. The primary owns shared production composition, complete identifier declarations, manuals, generated projections and final acceptance. This helper owns only its dispatched Generative source, schema, browser and test paths. The primary additionally granted the feature-specific grouping and draft changes in Chat ThreadStream and GenerativePresentationView, their tests, and the existing Generative block in worker-mcp-routes.test.ts. No host, external service or release effect is authorized.

## Working Checkpoint

The native Item source accepted only completed assistant messages. The new admission also accepts exact non-null completed Tool-result text and rechecks completion/digest on retained reads. Answer shorthand normalizes to an ordinary source Item before presentation publication and retains the original semantic hash. A source-only interruption remains recovery-required. No generation replay or publication repair is added.

The fixed internal Tool factory projects the ten Kernel operations plus native publish. The command entry must supply the native invoker and its trusted actor, scope and stable accepted Tool occurrence identity. The primary owns that join and the complete identifier declarations. The answer Item allocation depends on P14's shared deriveEntityId API; no local identifier formatter is introduced.

Browser grouping checks the exact admitted source ID, digest and same-Turn lineage. Failed admission releases the source to ordinary history. The source stays inspectable through Source history. Refresh preserves changed required scalar fields as a local draft over the new server observation. Historical reopen retains the original admitted values until explicit refresh.

## Evidence

All CPU-heavy commands use the shared run-slot.sh owner with the pinned Node/pnpm PATH, the helper TMPDIR, one Vitest worker, no file parallelism and no coverage. The first schema run failed collection before the protocol package had been built; it supplies setup evidence only.

- `pnpm exec turbo run build --filter='./packages/*' --concurrency=1`: 8 successful build tasks.
- `pnpm --filter @openkit/app-api-schemas exec vitest run src/generative-ui.test.ts src/operation-definitions.test.ts --maxWorkers=1 --no-file-parallelism --no-coverage`: 2 files, 11 tests passed.
- `pnpm --filter @openkit/nanocore exec vitest run src/generative-kernel/discovery.test.ts src/generative-ui/internal-tools.test.ts --maxWorkers=1 --no-file-parallelism --no-coverage`: 2 files, 4 tests passed.
- `pnpm --filter @openkit/web exec vitest run src/generative/source-groups.test.tsx src/screens/chat/GenerativePresentationView.test.tsx --maxWorkers=1 --no-file-parallelism --no-coverage`: 2 files, 7 tests passed. The stronger draft regression first failed because the renderer mutated accepted message data. The clone and draft-overlay correction passed the rerun.
- `pnpm --filter @openkit/web typecheck`: passed after correcting the new test fixture's completion metadata, Item status and Node crypto type declaration.
- Native openkit-generative MCP projection: 3 tests passed, including record creation, conditional mutation, exact replay and stale refusal.
- `pnpm --filter @openkit/nanocore typecheck`: one error only, the pending P14 deriveEntityId export. No other errors were reported.
- `node scripts/validate-doc-model.mjs`: 516 documents passed. Focused Biome checks and `git diff --check` passed.

The authenticated Worker relay extension passed: `pnpm --filter @openkit/nanocore exec vitest run src/worker-mcp-routes.test.ts -t 'serves one stateless-era client' --maxWorkers=1 --no-file-parallelism --no-coverage` ran one selected test successfully, with 34 unrelated tests not selected. It proves real native creation, conditional update, exact SDK request replay, stale conflict, disabled-user refusal and unchanged record revision/data. Original two-era refusal checks remain intact. Initial fixture failures identified a manually built modern MCP envelope, reused numeric identity across two SDK clients, and an attempted owner-membership removal refused by SQLite. The fixture now replays exact SDK request bytes after the original two-era probes, uses one native request stream, and disables/restores the fixture user without changing ownership. The native browser proof is prepared but not yet run. New answer-source publication still depends on the shared P14 identifier API and primary-owned complete producer declaration. No live Worker, a1 or abrupt process crash PASS is claimed.

## Next Action

Keep the delivery branch free of unlanded P14. The primary authorized a separate temporary validation worktree merged with candidate lane/id-cutover for a labeled non-landing source/browser probe. Reconcile only the feature fixtures in that candidate, build and run the focused native source/browser checks, retain candidate evidence separately from final verification, and return exact evidence plus the required production integration to the primary. Live selected-Worker/a1 journey and abrupt process crash proof remain separate evidence until performed by their authorized owners.
