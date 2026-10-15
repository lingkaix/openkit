---
status: Accepted
date: "2026-10-15"
decider: Engineer
---
# Discord First And Desktop Deferred

## Decision

D07 selects Discord as the first team channel. Bind channel accounts to current Core actors and reuse Core authorization, inbound deduplication, exact Pending Request response, and truthful delivery contracts. Direct responses are limited to request kinds explicitly admitted by the common channel contract. Email initially sends attention/digest links back to the App. Slack, Signal, and broader Email actions remain separate later channel scope; Discord evidence does not complete them.

D08 defers all OpenKit Desktop application development beyond the first version, v0.1.0. This includes shell, distribution/signing, credentials, local/remote connection, updater, installation, and recovery work. No first Desktop platform was selected. The Web product and existing external Agent/operator interfaces retain their accepted scope.

## Reason

Source: engineer-rulings-20261015.md, Verbatim reply and Resulting rulings, in the coordinator's backlog-20261015 record. On 2026-10-15 the engineer replied "Discord" for D07 and stated that all Desktop development is deferred and is not part of the first version. The first recommended D07 option in decisions-zh.md supplies the common identity/deduplication/response/delivery constraints and Email link-only posture. The coordinator requested this fourth owner amendment group. The external record preserves source evidence, not independent design authority.

The engineer named the actual first channel and expressly removed Desktop development from the first-version scope. No platform is inferred from the development machine. Account availability and real external delivery remain necessary business inputs and effect authorization; this ruling does not send a message or disclose a credential.

## Rejected Alternatives

- Email-only delivery was not selected instead of the first Discord channel.
- Simultaneous full Discord, Slack, Signal, and Email implementation exceeds the selected staged scope.
- A thin Desktop shell in the first version and a Desktop-managed Core/NanoHost installer are both deferred.

## Revisit When

Revisit additional channel actions for a named accepted use case and exact actor, request, audience, delivery, and failure contract. Revisit Desktop only after v0.1.0 with explicit activation, selected platform, and accepted distribution/credential/update/recovery owners.

## Affected Owners

- [Communication](../core/communication.md)
- [Web UI Rebuild Stack](../specs/20260710-web_ui_rebuild_stack.md)
- [Roadmap](../roadmap.md)
