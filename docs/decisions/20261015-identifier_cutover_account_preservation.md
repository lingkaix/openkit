---
status: Accepted
date: "2026-10-15"
decider: Engineer
---
# Identifier Cutover Account Preservation

## Decision

For the identifier cutover before the first stable release, account preservation uses same-name re-registration on a staged clean candidate under new canonical record ids. The engineer grants the reset authorization for the three deployments named by [Release Management](../specs/20260829-release_management.md#pre-stable-deployment-reset-and-protected-accounts) in one grant. The procedure verifies every protected account through public sign-in and the required administrator operation before switching. It converts no account data and adds no old-id reader. Existing disclosure, writer fencing, protected-account and non-OpenKit service boundaries remain binding.

## Reason

On 2026-10-15, the coordinator presented two options: re-register the same protected login identities on a clean candidate, or convert only the account records. The engineer accepted the first option and granted authorization at once. Translation of the answer: "Do as you recommend: re-register under the same names. You do not need to ask for authorization separately again; I give you all the authorization at once." The coordinator relayed this accepted ruling to P14 and confirmed that D5 requires no account data conversion.

The protected-account invariant concerns the engineer-named login identities and usable access. The previous record ids cannot remain canonical across this cutover. A staged candidate allows the operator to prove the new registration and required access while retaining the source installation for inspection. The grant authorizes the exact deployment transition; it does not make ordinary startup a reset owner or prove that a transition has occurred.

## Rejected Alternatives

Converting only the account records was rejected in favor of same-name re-registration. Retaining old identifier readers would conflict with the accepted identifier mechanism and supplies no account-continuity proof.

## Revisit When

The first stable release establishes retained-data continuity, or the engineer changes the protected-account requirement or authorized reset scope.

## Affected Owners

- [Release Management](../specs/20260829-release_management.md#pre-stable-deployment-reset-and-protected-accounts).
- [Pre-Stable Data Continuity](20261014-pre_stable_data_continuity.md).
- [Core Protocol](../core/protocol.md#ids).
