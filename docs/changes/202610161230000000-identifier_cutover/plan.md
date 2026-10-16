---
type: change-plan
status: in-progress
started: "2026-10-16"
branch: lane/id-cutover
---
# Identifier Cutover

## Intent Revision 1 — 2026-10-16

Source: the engineer's lane direction, relayed by the coordinator on 2026-10-16. P14 is one end-to-end increment: shared UUIDv7 allocation, owner-declared UUIDv5 names, typed boundaries, every consumer and fixture, generated projections, and an account-preserving reset procedure dry run. Begin independent work on current main, absorb the reviewed drain, then land through the exclusive landing-window protocol with exact-head independent review and full CI. No real wipe, account operation or host contact is part of this increment. No compatibility reader, migration, replacement replay authority or new registry is permitted. AGENTS.md remains engineer-owned.

## Owners And Accepted Decisions

[Core Protocol](../../core/protocol.md#ids) owns encoding, kind admission and exclusions. [One Identifier Mechanism](../../decisions/20261014-one_identifier_mechanism.md) owns the governing choice; [Pre-Stable Data Continuity](../../decisions/20261014-pre_stable_data_continuity.md) owns the reset boundary. Each allocating specification retains its exact name, trigger and lifecycle. P11's accepted owner batch through 4e0740f3 supplies the additional producer names, independent S51 remint table and immutable grant issuance rule; its drain landing must precede integration. Accepted owner text governs over prior preparation predictions or existing deterministic code.

## Acceptance Observations

Independent entities use one shared UUIDv7 generator with canonical lowercase prefixed text. Owned deterministic names use fixed kind namespaces and RFC 8785 JCS over every declared immutable input, including purpose, ActorRef and native JSON types. Named-kind boundaries reject malformed, wrong-kind, wrong-version and wrong-variant values before effects. Opaque selectors and native identities stay unchanged. Exact retry and restart return original identities without repeated contacts or publications. Import retains source closure through one target map entry per eligible source owner and preserves its filesystem/SQLite crash gap. Imported grants remain non-authorizing after restart and rebind. Conversation Task handoff uses its accepted separate receiving Thread. The reset dry run proves a staged clean candidate, same-name re-registration, verification and switch using synthetic accounts only, retaining old scope and evidence without a real reset.

## Working Checkpoint — Rewritable

The lane started from main 97594a575bdba2f7e26e03cbf517d5ce6e841ff7. The reviewed drain has landed at main 79291fa9ca7a17a7bb54b86eb2b6d37a8e9d22ef, including P11 through 4e0740f3; the next integration step absorbs that base. The coordinator permits L-ID to prepare shared integration files on its own branch outside the window. These edits absorb the drain on rebase. The landing window is acquired only when the lane is ready to rebase, gate and land, and is not held while waiting. The first seam is a browser-safe shared identifier codec in the Protocol package. Focused regressions observed 25 failures against the former UUIDv4/permissive baseline before implementation. Tests use independently computed namespace/name vectors and check canonical JSON types, Unicode, invalid clocks, entropy failure and kind admission. Producer conversions are staged outside shared composition. Runtime notes and exact command outputs remain in private P14 lane evidence; the short checkpoint names current work and the next seam.

## Verification And Landing

Run the existing suites for each affected module with one worker through the shared CPU-slot runner, then check:repo, lint and typecheck. After the drain, acquire the landing window, rebase, wire shared schemas and compositions, regenerate Protocol JSON Schema, OpenAPI and CLI as one final source batch, and run affected suites and generated-parity checks. An independent gpt-6.1-sol reviewer reads the actual origin/main..head diff in a detached read-only worktree. Push the lane branch, run full CI on that exact head, and land only with the approved review and green run through bin/land.sh. A failed main-push gate is fixed or reverted by this lane. No execution or approval is claimed before its direct evidence exists.

## Accepted Bounded Completion

The coordinator accepted the newly found deletion-recovery export producer on 2026-10-16. Its exact UUIDv5 name is ["delete", requestId] in the wsexp namespace d8e266d0-77a0-5e91-b599-de82740626ff. Add the single-producer Protocol row and Workspace Deletion step-4 declaration in this landing. Preserve the current trigger and authority check that reconstructs and binds the exact recovery export ID and digest. Tests must prove stable same-request identity, distinct requests and refusal of a non-matching ID. This is a bounded completion of the accepted mechanism, not authority for other export derivations. Similar small gaps that follow accepted patterns are delegated to P14, with explicit checkpoint and final-review disclosure.

The current consumer checkpoint covers canonical Worker/Harness lineage and the remaining public and private named metadata boundaries. Preserve explicit Worker handoff Knowledge selection when moving its Thread; the new identifier tuple does not authorize changing query triggers or selection bytes. Existing module suites and focused red/green evidence precede the final drain rebase and complete exact-head gates.
