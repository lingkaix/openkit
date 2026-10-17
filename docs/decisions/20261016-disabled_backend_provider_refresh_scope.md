---
status: Accepted
date: "2026-10-16"
decider: Coordinator fallback under the engineer-authorized coordination rule
---
# Disabled Backend-Provider Refresh Scope

## Decision

Keep backend-Provider attachment and delegated refresh disabled in the current release. Remove the empty NanoCore refresh-status polling service and its collector interface and forwarding methods. The [mechanism owner](../specs/20260703-openshell_mechanism_internalization.md) retains the attachment, grant, explicit delegation, exact-effective-policy-equality, redaction and canonical-evidence requirements for future enablement. This scope replaces the timer-relocation premise of #154; it does not implement native refresh collection or establish its acceptance.

## Reason

Source: L-RT checkpoint Intent Revision 15, coordinator fallback notice at 17:52 UTC on 2026-10-16. The release-scope question remained unanswered beyond the engineer-authorized fifteen-minute coordinator fallback interval. The primary therefore applied the recommended disabled scope after independent Consultant scrutiny. This records that fallback, not a direct coordinator answer or a new engineer approval inferred from silence.

The current backend refuses Provider credentials before native effects, NanoHost creates no Provider attachments, and the collector returns an empty array. The automatic timer discards that array. Removing this path loses no observation, refresh execution or canonical evidence. The pinned stock SDK has a refresh-status API, but that API creates no admitted OpenKit Provider subject or lineage by itself. Subscription-account and SDK channel-token refresh retain their separate owners.

## Rejected Alternatives

- Moving the timer to NanoHost would retain an empty observation path and would not complete #154.
- Enabling the whole governed attachment and delegated-refresh capability in this increment exceeds the selected release scope and requires its existing policy and evidence prerequisites.
- Keeping an empty collector or compatibility service preserves unused responsibility without a supported consumer.

## Revisit When

Revisit when the release scope includes backend-Provider attachment and delegated refresh and the existing authorization, exact-policy-equality and canonical-evidence boundaries can be implemented together.

## Affected Owners

- [OpenShell Mechanism Internalization](../specs/20260703-openshell_mechanism_internalization.md)
