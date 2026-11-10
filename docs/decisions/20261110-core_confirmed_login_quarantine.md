---
status: Accepted
date: "2026-11-10"
decider: "Coordinator, CRED-2 ruling at 05:14 UTC"
---
# Core-confirmed Login Quarantine

This decision permits a restricted Worker quarantine after Core confirms a permanent Login refresh failure. The [private Login metadata contract](../specs/20260703-vault_secret_injection.md#private-login-metadata-operations) and [Policy Enforcement Mapping](../specs/20260703-policy_enforcement_mapping.md) own the resulting rules.

## Decision

Use the existing quarantine operation and its standard mediation, decision, Audit and native checks. Retain the actual Worker as caller. Authorize only the exact Core-correlated family, reviewed runtime-token grant and material generation. Route its evidence to the Login owner's existing User scope. Release remains owner/admin-only. Add no retained format, operation or notification scope.

The implementation must establish Core failure provenance, exact invocation correlation and current authority through publication. Unknown or stale facts fail closed. Quarantine and the failed binding retain separate outcomes; neither implies rollback of an external effect or automatic retry. Independent authority regressions and review must qualify the restricted path.

## Reason

Core owns refresh and can distinguish a confirmed permanent failure from a Worker claim. Quarantine removes selection authority without releasing material or granting another administrative action. Requiring a separate owner action would leave the confirmed unusable family selectable, contrary to automatic quarantine. Treating Workspace use as general User administration would grant excessive authority and lose the real caller's attribution.

## Rejected Alternatives

An owner/admin-only manual quarantine preserves the ordinary admission contract but does not satisfy automatic quarantine for shared Login use. Borrowing the owner's identity or reusing the binding decision would bypass separate quarantine authorization. A separate quarantine service or retained failure registry adds an owner that the existing operation does not need.

## Revisit When

Revisit before expanding the caller class, permitting release, changing the evidence owner or failure authority, or adding retained state. These changes exceed this restricted ruling.

## Affected Owners

- [Private Login metadata operations](../specs/20260703-vault_secret_injection.md#private-login-metadata-operations): exact failure correlation, restricted quarantine, owner evidence and incomplete outcomes.
- [Policy Enforcement Mapping](../specs/20260703-policy_enforcement_mapping.md): narrow Worker Kernel admission and separate User mediation.
