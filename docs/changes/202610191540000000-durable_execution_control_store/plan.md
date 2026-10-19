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

## Intent Revision 6

Independent review returned ACCEPT WITH FIXES. The engineer settled receipt-consumption lifetime, keyed cross-Workspace activation, missing recovery deletions, server execution discovery, reservation tombstones and refusal identities, durable capture exclusion, the closed Worker-Turn sequence and peer acceptance dependencies. The follow-up telemetry review assigns marker variants and trust keys to telemetry, and root/step identity, lifecycle classification, sample units and late observations to this mechanism. Preserve typed span fidelity. Compress duplicated explanation without removing the failure, deletion or ablation criteria; create a new commit, with no agents or implementation changes.

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
| Earlier no-durable-trace decision | Journal-only OTel correlation exception; no Sandbox SDK/exporter or transport-body trace state. The telemetry owner supplies the narrow marker amendments. |
| Retention physical placement and backup layout | New mechanism supplies receivers; respective authors retain exclusive edits to their active specifications and their product decisions. |

## Checkpoint

The initial documentation commit received independent acceptance with required corrections, not implementation acceptance. The correction draft is 4,457 whitespace-separated words in 449 lines, reduced from 8,641 words in 327 long lines. Paragraphs and table rows remain complete without hard-wrapping sentences. Final review of the corrections remains independent; the producer does not accept this rewrite.

The transfer table below records compression and the new receiver rules. Only the duplicate version concept, unmeasured handle constants, manifest algorithm prescription and repeated explanation were removed as criteria. The specification stays Draft/Not Started; resource values and ablation outcomes require implementation evidence.

## Verification And Closeout

Observed checks with pinned Node 24.18.0: `node scripts/validate-spec-lifecycle.mjs` exited 0; `node scripts/validate-doc-model.mjs` exited 0 and validated 626 documents; `node scripts/generate-doc-index.mjs --check` exited 0; `git diff --check` exited 0. The initial index-generator invocation failed before checking documents because `yaml` was absent and the shell selected Node 26.8.2. Selecting the installed pinned toolchain and running locked, offline, root-filtered dependency installation with scripts disabled corrected setup without changing dependency manifests. That setup failure is not a documentation failure or a passing check. A later document-model run correctly failed on a reference to the phase-marker author's not-yet-present decision file. The correction references the accepted ruling recorded in this change and the existing telemetry owner; it creates no placeholder and bypasses no link check.

The initial commit changed 16 Markdown files: 4 Core owners, 9 specifications including the new Draft, one decision record, one generated index and this execution record. The bounded coordination census replaces seven existing families with three; reused signals/timers and moved product families are not new families. The new closed step-state set and release-authored step kinds belong only to the engine, not public protocol. No source/test/configuration changes, agents, live runtime effects, push, publication or reset occurred. Backup/export, telemetry and retention-default files remain with their assigned authors; their receiver alignments are integration work, not silently completed here.

Initial self-review inspected the actual Core/bootstrap diff and document bytes, corrected source paths and retained all 27 dispositions. The correction round adds no production tests: the named crash cases are implementation acceptance obligations, not executed proofs. The phase-marker decision is absent from this branch; its exact filename and integration requirement remain explicit, while existing peer owners have resolvable links. The coordinator must integrate and link that decision, without a placeholder or validator bypass here.

## SQLite Scale And Lifetime Ruling

The engineer accepted the [write/space budget](../../specs/20261019-durable_execution_and_control_store.md#write-and-space-budget) and [deferred Thread cold tier](../../specs/20261019-durable_execution_and_control_store.md#deferred-thread-cold-tier). First-release creation/deletion/Thread-partitioning rules make later archive support additive; Light App databases are included in OpenKit's SQLite settings, opaque MCP databases are not. Load measurements select limits, not this documentation. Thread-database partitioning remains an unbuilt escape hatch; archive implementation remains after `v0.1.0`, estimated at 3–5 engineer-days. The replacement inventory is unchanged. This ruling adds no implementation or measured performance claim.

## Review Correction And Compression Transfer

| Previous section or finding | Receiving criterion |
| --- | --- |
| Commit rule, scope map and configuration/Knowledge paragraphs | Commit Rule and Workspace authority table retain synchronization, cache publication, exact revisions, scope ownership, external references and app/opaque-writer coverage. |
| Snapshot invariants and F6 | Snapshot Cut replaces the nonexistent existing hold with one durable backup capture record; active records exclude Workspace Storage GC and Notebook prune/repack across restart, until verified finish or explicit abandonment. The extra backup family is declared outside the coordination census. |
| Primitive, cancellation, native loss and human-wait prose; F7 | Minimal Engine and the closed Worker-Turn table retain states, current authority, receipts, retry limits, later-Turn delivery, terminal unknown, linked inspection and physical versus local exclusion. One execution-definition version remains. |
| OTel fields, exception and export behavior | Step Journal retains exact typed span fields, diagnostic content limits, open visibility, ended immutability, lossy delivery isolation and work-owned retention. Typed int64/double/count tests are explicit. |
| Telemetry marker and root/stage findings | Closed variants remain telemetry-owned; journal admission sets the report trust keys. Journal-To-Lifecycle Mapping owns root lifetime, ten-stage classification, retry samples and late Host observations. |
| Effect/deadline paragraphs | Effect And Deadline Semantics retains idempotence/current-authority/budget conjunction, no blind unknown replay, persisted expiry and authenticated non-extending carriage. |
| Ready index and F4 | Global Dispatch explicitly discovers and wakes server as well as Workspace executions; one server-only image restart test. Resource-tested bounds replace the unmeasured 32/4 defaults. |
| Reservation gaps and F5 | Exact invocation identity, immutable refusal, fresh later admission, absent-key cancellation tombstone and deadline/restore retention replace the incomplete held/released description. |
| Receiver preservation and F1 | Physical Receipt Consumption plus the NanoHost boundary require durable consumer outcome and acknowledged consumption before result retirement; the competing-successor crash case is explicit. |
| Activation and F2 | Cross-Workspace Activation makes B's source/admission/receipt tuple locally complete; inventory/class 01 remove source scans without claiming cross-database atomicity. |
| Missing deletion rows and F3 | Inventory explicitly disposes call-loss settlement, turn.reap, Task fact-to-file repair, observation JSONL/sequence and worker-control rebuild; preserved domain families remain. |
| Portability, retention slots/capture gaps and cost | Corresponding tables retain local closure, external authority limits, raw/capture-owner distinction, incomplete coverage and lossless sharing; sequence algorithm detail is deleted. |
| Ingress and ablation matrices | All 27 normalized classes and individual clocks/fences remain, with class 13 distinguishing open inspection from terminal unknown. |
| Implementation/open decisions and F8 | Five increments remain; Acceptance Dependencies replaces the open-decisions section and conditions acceptance on retention, backup/move and telemetry amendments and direct tests. |

Correction-round verification with pinned Node 24.18.0: index generation, `node scripts/validate-spec-lifecycle.mjs`, `node scripts/validate-doc-model.mjs` (626 documents), `node scripts/generate-doc-index.mjs --check` and `git diff --check` all exited 0. The four-file correction contains only the mechanism, NanoHost boundary, generated index and this record. Exact source enumeration retains classes 01 through 27; the old marker keys and numeric handle defaults are absent. These checks do not accept runtime behavior or peer integration.
