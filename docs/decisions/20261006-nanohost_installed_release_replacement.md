---
status: Accepted
date: "2026-10-06"
decider: Engineer
---
# Installed NanoHost Release Replacement Through The Operator Skill

## Decision

Support option A: explicit operator replacement of an installed, enrolled NanoHost using the unchanged verified installer, with retained deployment identity, enrollment, credential slots, configuration, images, and Worker data. [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md#installed-release-replacement) owns the transition. Place the procedure in `skills/openkit-ops` and recommend and guide users to have an external Agent perform it with their authorized host tools. App/Web update remains separate, with an assessed order for each exact release pair.

## Reason

On 2026-10-06 the engineer selected option A and said, translated from Chinese: "Put it in that admin/operator Skill; consider, recommend, and guide users to use an external Agent to do this work." The reason is that users will use an external Agent for this work. A user must be able to take a later NanoHost release while keeping the installed deployment and retained data. A stopped operator procedure supplies that path without adding a new installer mode or updater.

## Rejected Alternatives

- B, an installer replacement mode: adds replacement admission, expected-old identity, concurrency, recovery, and output contracts without a demonstrated need beyond the explicit operator procedure.
- Keep the V1 replacement exclusion: leaves the first-release user without a supported retained-host path to the next release.
- Direct payload copy: bypasses or duplicates verified bundle admission, host checking, conflict handling, and no-overwrite publication.
- Destructive uninstall and fresh enrollment: decommission is a different terminal lifecycle and cannot satisfy ordinary retained deployment and data continuity.

## Revisit When

Isolated replacement and interruption observations show that the operator procedure cannot reliably prevent mixed-set activation or preserve recoverability, or repeated operation demonstrates a concrete need for machine-enforced replacement. A retained-format migration or incompatible admission/readiness release pair requires its separately accepted transition before shipping, rather than silently broadening this decision.

## Affected Owners

- [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md)
- [Deployment Host Requirements](../specs/20260909-deployment_host_requirements.md)
- [Agent Operator Skill](../specs/20260910-agent_operator_skill.md), for the non-authoritative operator projection.
- [App Update Delivery](../specs/20260910-app_update_delivery.md), whose separate operation and readiness predicates remain unchanged.
