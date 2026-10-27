---
status: Accepted
date: "2026-10-27"
decider: Engineer
---
# Inline Retained Work Bodies

## Decision

On 2026-10-27, the engineer approved exact retained Item and Item-event entry bodies of at most 65,536 UTF-8 bytes inline in their owning control SQLite. Larger bodies keep immutable files. The existing file descriptor remains unchanged as a current representation; inline is additive. New revisions select their representation by exact byte length. Existing file references retain their bytes, holds and retention without conversion or reinterpretation. The writer verifies exact bytes, length, digest, retained format and lineage before FULL acknowledgement.

This narrowly supplements the file-content choice in [Durable Execution And Control Store](20261019-durable_execution_and_control_store.md). That accepted record remains unchanged, and its other decisions remain current. Turn CAS, the ordered acknowledgement chain, per-Item FULL acknowledgement, current authority and public wire stay unchanged. This decision authorizes no converter, reset dependency, second writer or separate byte store.

Implement the inline change after the Workspace capture owner lands, then measure it with the unchanged reference populations. Sequence allocation, Turn-CAS removal, same-Turn batching changes and a progress durability class require demonstrated remaining need and their own accepted owner changes. The engineer's separate consent to a weaker progress class is not activated here.

## Reason

The measured native append path spends substantial time preparing and publishing small immutable files. Exact inline bytes remove that file preparation within the existing SQL transaction authority. The threshold bounds each inline entry without changing admission limits. Keeping existing file descriptors valid avoids a converter, reset dependency or duplicate writer. A staged measurement can establish whether further append changes are necessary without attributing several simultaneous changes to one result.

## Rejected Alternatives

A converter for existing file references adds work without removing a current authority. A reset-dependent representation would impose an unnecessary deployment constraint. Rewriting the earlier accepted decision would erase the reason for the earlier boundary. Bundling sequence allocation, Turn-CAS removal, new batching or weaker progress durability before the inline measurement would prevent attribution and add mechanisms before demonstrated need. Inline Artifact originals or another Storage backend would exceed this retained work-entry scope.

## Revisit When

Revisit the next append mechanism only when the unchanged-population measurement proves a remaining bottleneck that the existing owner cannot carry. Revisit this representation if exact-byte, crash, capture or reopen evidence defeats its boundary. Any durability relaxation outside the separately consented progress class, authority change or data-continuity change still requires its governing decision.

## Affected Owners

[Storage](../core/storage.md#item-log-invariants) owns the amended behavioral rule. [Durable Execution And Control Store](../specs/20261019-durable_execution_and_control_store.md#commit-rule-and-scope-layout) remains its Draft implementation projection. Existing Work Data Retention, content holds, Workspace capture and replay owners retain their exact-byte, admission and recovery obligations. No public operation or retained Item meaning changes.
