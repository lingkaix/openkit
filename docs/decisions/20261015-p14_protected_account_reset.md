---
status: Accepted
date: "2026-10-15"
decider: Engineer
---
# P14 Protected Account Re-Registration And Reset Scope

## Decision

For the P14 pre-stable identifier cutover, stage a clean candidate and re-register the same engineer-named login identities under new canonical User and authentication-account record IDs, using operator-held credentials. Verify each designated registration and fresh login before switching, and verify the required operation with the designated administrator account. Do not expand another account's authority. Re-issue administrator tokens into operator configuration only. Convert no predecessor account data and add no old-ID reader.

The engineer grants the OpenKit identifier-reset authorization for the development machine, a1 staging and a2 production at once. No repeated authorization question is required for that same scope. The selected target still requires the exact candidate/data boundary, public incompatibility disclosure, writer fencing and protected-account evidence. The coordinator retains implementation and effect-stage dispatch. The grant changes neither ordinary automated updates nor future production reset authority.

Preserve unrelated development-machine host state. On a1, navidrome, blinko, memos and Dokploy remain untouched. On a2, every non-OpenKit service remains untouched. Private account lists, credentials and their locations stay outside repository evidence.

## Reason

Source: engineer-rulings-20261015.md, P14 D5 and reset authorization, in the coordinator's backlog-20261015 working record, about 11:50Z on 2026-10-15. The coordinator proposed same-name re-registration on a staged clean candidate because old record IDs cannot be retained unchanged under the incompatible identifier format. The independent Consultant had required engineer confirmation of that protected-account interpretation. The engineer accepted the recommended option and supplied the three reset authorizations in one grant.

The following is a translation of the engineer's answer: "Do as you recommend: re-register under the same names. You do not need to ask for authorization separately again; I give you all the authorization at once." Same-name usable access is the accepted continuity criterion for these accounts. It does not claim predecessor entity-data continuity or rollback compatibility.

## Rejected Alternatives

- Converting only account records was not selected.
- An old-ID reader or account converter would exceed the accepted clean-candidate cutover.
- Repeated reset permission requests would disregard the explicit three-target grant.
- A host-wide wipe or general production update grant would exceed the OpenKit scope and protected-service exclusions.

## Revisit When

Return a changed deployment scope, changed protected-account interpretation, unresolved fence or required non-OpenKit effect to its owner. Missing factual inventory requires inspection under the authorized effect-stage dispatch, not another question for the same reset authorization. A later cutover has no authority from this grant.

## Affected Owners

- [Release Management](../specs/20260829-release_management.md)
