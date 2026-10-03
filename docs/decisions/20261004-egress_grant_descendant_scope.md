---
status: Accepted
date: "2026-10-04"
decider: Coordinator, under the engineer's standing delegation to decide in the engineer's absence, on an independent Researcher's analysis and Reviewer verification
---
# Egress Grant Descendant Scope

## Decision

The Coordinator decided that Authorized binaries means the resolved executable-and-descendant scope of a network grant, owned by [Agent Manifest And AEP Resolution](../specs/20260703-agent_manifest_aep_resolution.md#manifest-shape). A connection matches when its socket-owning executable or an executable in its observed ancestor chain is listed, within the grant's exact destination and REST restrictions. A granted general interpreter, including a Node interpreter used by the Harness, covers its observed descendant tree; binary lists do not provide script-level or intra-Sandbox principal isolation. Default-deny destinations, exact REST method and path rules, the Git receive-pack exclusion, credential custody and Gateway authority remain the external boundary. This is an owner amendment only and introduces no code change or new mechanism.

## Reason

The engineer's [full-capability ruling](20261001-sandbox_full_capability_rulings.md) makes a Sandbox a complete work environment whose checks draw the external boundary while workers use their capability inside it. The Coordinator selected executable-and-descendant scope to preserve that useful environment and explicit external authority under the official unmodified stock backend. Independent research found deliberate socket-owner-or-ancestor matching in the pinned OpenShell release, and its normal structured policy cannot express self-only matching. The compiler carries the authored binary list into that matcher; the earlier expectation that an unlisted child executable be refused reflected an unstated self-only assumption. Granting a general interpreter admits arbitrary code through that interpreter, so moving a worker outside one interpreter's ancestry would not create script-level or intra-Sandbox principal isolation. Independent Reviewer verification found that the owner amendment states this breadth while preserving the existing endpoint, REST, credential and Gateway restrictions.

Source research: temp/interface-unification/reports/egress-binary-grant/research-report.md. Source decision: temp/comm-redesign/engineer-queue.md, entry "Binary-scoped egress grants cover the granted executable and its descendants", dated 2026-10-04. Source verification: temp/interface-unification/reports/egress-scope-verify/review-report.md. These are provenance references, not behavioral authority.

## Rejected Alternatives

- Self-only matching: the stock backend lacks a structured-policy capability for it; requiring it would fail launches closed until a supported backend capability exists.
- Relaunching native workers outside the Node Harness ancestry: it adds launch responsibility without providing a general separation, because a worker can still spawn the granted interpreter and its children.
- Custom OpenShell rules or a patch: that route is outside the accepted official unmodified stock-backend contract.

## Revisit When

A later stock OpenShell release offers self-only matching and the engineer wants that scope. Reopening the decision requires an explicit owner amendment; the current executable-and-descendant contract remains binding meanwhile.

## Affected Owners

- [Agent Manifest And AEP Resolution](../specs/20260703-agent_manifest_aep_resolution.md)
- [OpenKit Policy Model](../specs/20260629-openkit_policy_model.md)
- [Worker Sandbox Freedom Policy](../specs/20260709-worker_sandbox_freedom_policy.md)
- [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md)
