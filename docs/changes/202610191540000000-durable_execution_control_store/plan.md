---
type: change-plan
status: implemented
date: "2026-10-19"
---
# Durable Execution And Control Store Design

This record preserves execution context, not design authority. The [engineer decision](../../decisions/20261019-durable_execution_and_control_store.md) records the direction; [Storage](../../core/storage.md), [Runtime Model](../../core/runtime-model.md), [Fault Tolerance](../../core/fault-tolerance.md), and the [Draft mechanism](../../specs/20261019-durable_execution_and_control_store.md) hold the resulting rules and proposal.

## Intent Revision 1

The engineer's 2026-10-19 direction requires a documentation-only replacement of split mutable authority and bespoke recovery before `v0.1.0`. Preserve one transaction per transition, Workspace portability, truthful external-effect uncertainty, one propagated deadline, durable work-data retention and mandatory one-at-a-time ablation. Add the decision record and a Draft mechanism; keep Core edits minimal. Do not change source, tests, configuration, protected product intent or agent contracts. Commit the branch for separately arranged independent review; no agent dispatch or deployment effect is authorized.

## Intent Revision 2

The same day's clarification requires reuse of the Storage Service, a rebuilt global ready index, bounded Workspace database handles, server-owned idempotent capacity reservations and both commit-gap dispositions. Keep server configuration server-scoped, Knowledge semantics with their owner, later-Turn human outcome delivery and the Goal freeze. Prefer stock systemd backoff with an older-version fallback. Pre-stable cutover uses one authorized reset without converters.

## Intent Revision 3

The same day's addendum requires the SQLite step journal to use OTel span fields, with one execution trace and one span per step. Journal correlation is the sole retained trace exception; ended steps project losslessly and open steps do not export. Full-capture layout deduplicates messages, parts, prompts and tool definitions. Retention defaults remain a separate author's responsibility. The backup/move author exclusively owns changes to the existing backup/export specification.

## Intent Revision 4

The same day's second addendum requires an explicit classification of Notebook refs, Light App databases, authored configuration, catalogs and opaque MCP process data. Each needs a commit and hot/quiesced snapshot rule. Prefer fewer databases and justify retained independent stores. No backup-operation implementation or Goal design is admitted.

## Intent Revision 5

The same day's third addendum permits narrowly allowlisted Worker phase markers over existing worker control. Core validates and bounds them before accepting unverified events on open journal steps; they cannot decide execution or fences. The separate retention amendment will default capture on, retain model I/O through deduplicated blobs and native transcripts verbatim. Minimal Workspace backup, restore and move are now required for `v0.1.0`, superseding the earlier permission to defer operations. Their separate author keeps exclusive ownership of the backup/export specification.

## Criterion Transfer Map

| Previous owner and concern | Receiver and preserved boundary |
| --- | --- |
| Core Storage: file-first and SQLite companion defaults | Scope control transaction and immutable content; existing domain identities, retention, Vault, app business stores and external-data limits stay. |
| Core Runtime: separate recovery interpretation | Same normal/restart execution owner; native loss still interrupts, later-Turn human delivery and exact physical fences stay. |
| Core Fault Tolerance and Bootstrap: undifferentiated authoritative boot refusal | Owning-scope refusal, inspectable Workspace quarantine, unchanged server/shared-authority refusal and no empty replacement. |
| Storage Layout and Scheduler: file/Workspace/server joins, queue/attempt/checkpoint and backend handoff flags | Replacement inventory, seven-to-three coordination-family census, global ready index and capacity commit-gap table. |
| NanoHost: fixed restart cadence and independent acceptance allowances | Stock bounded backoff and authenticated remaining-deadline carriage; prevented exits, transport identities and physical fences stay. |
| Notebook and shared Storage: mutable Git-ref publication | Scope database head and atomic local receipt/Audit over immutable Git content; semantic validation, history, paths and reference-only retention stay. |
| Recurring Triggers: separate scanner and publication recovery | Same recurring records and semantics through durable timers and Workspace admission transaction. |
| Earlier no-durable-trace decision | Journal-only OTel correlation exception; no Sandbox telemetry or transport-body trace state. Telemetry author owns the peer alignment. |
| Retention physical placement and backup layout | New mechanism supplies receivers; respective authors retain exclusive edits to their active specifications and their product decisions. |

## Checkpoint

The documentation draft and owner alignment are implemented; independent design review remains pending and is arranged by the coordinator. Baseline source inspection was against `fc0f43545`; it establishes record/table ownership and test locations, not runtime qualification. The new mechanism is longer than the writing guide's soft word-count trigger because it combines one replacement mechanism with the mandatory deletion census, 27 failure dispositions and ablation matrix. The author kept one cohesive document rather than split one commit/recovery contract across files; independent review must assess that choice.

Existing specification/document validators, index generation/check and whitespace checks have passed on the draft. Re-run them after the final text edits, then commit for the arranged independent review. Expected observable: valid metadata, resolvable links, an exact generated index, clean whitespace and a docs-only diff. These structural checks do not prove durability, capture completeness or fault behavior. Runtime acceptance remains the named implementation gates; the producer does not accept this authority-bearing design.

## Verification And Closeout

Observed checks with pinned Node 24.18.0: `node scripts/validate-spec-lifecycle.mjs` exited 0; `node scripts/validate-doc-model.mjs` exited 0 and validated 626 documents; `node scripts/generate-doc-index.mjs --check` exited 0; `git diff --check` exited 0. The initial index-generator invocation failed before checking documents because `yaml` was absent and the shell selected Node 26.8.2. Selecting the installed pinned toolchain and running locked, offline, root-filtered dependency installation with scripts disabled corrected setup without changing dependency manifests. That setup failure is not a documentation failure or a passing check. A later document-model run correctly failed on a reference to the phase-marker author's not-yet-present decision file. The correction references the accepted ruling recorded in this change and the existing telemetry owner; it creates no placeholder and bypasses no link check.

The change has 16 Markdown files: 4 Core owners, 9 specifications including the new Draft, one decision record, one generated index and this execution record. The bounded coordination census replaces seven existing families with three; reused signals/timers and moved product families are not new families. The new closed step-state set and release-authored step kinds belong only to the engine, not public protocol. No source/test/configuration changes, agents, live runtime effects, push, publication or reset occurred. Backup/export, telemetry and retention-default files remain with their assigned authors; their receiver alignments are integration work, not silently completed here.

Self-review inspected the actual Core/bootstrap diff and the new document bytes, corrected source path names, and kept the 27-class disposition complete. Remaining judgments are the mechanism details identified in the Draft, its soft-size review, version-specific service qualification, app/MCP snapshot coordination and unmeasured ablations. Commit authorization does not satisfy independent review. The external result report identifies the exact commit and final file line counts.
