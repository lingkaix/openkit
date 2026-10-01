---
status: Accepted
date: "2026-10-02"
decider: Engineer
---
# Gateway Route Lineage Home

## Decision

Each attributed logical Gateway invocation has one CapabilityCall, opened before the route plan runs and finished once at the logical terminal outcome. Its optional `extensions` document persists in a new nullable text `extensions_json` column on `capability_calls`; `openkit.gateway/routeLineage` holds ordered `unavailable` and `attempt` entries, including same-member retries. New calls that can span members leave their own `providerRef` null; UsageRecord retains measured-member attribution, and the released entry identifies the serving member descriptively. The existing Workspace `audit.read` capability-usage reader gains a redacted projection. Gateway owns selection and the call boundary; Audit, Usage, And Evidence Records owns storage, measurements, projection, and portable extension preservation.

A caller-supplied `metadata.openkit.requestId` that already has a CapabilityCall, running or terminal, is refused with the existing `invalid_request` kind before any Provider call. No stored outcome is returned in place of this refusal, and another Provider effect is not recorded on the old row.

Workspace route lineage stores no `accountSlotId`: a Workspace record is not a safe home for a server-level account identity, and no named reader needs it. It is not stored unprojected for a possible future audience.

A public call without Workspace lineage or without the Core database retains the declared blind gap and only request-local selection. Identical usage reports still collapse through the existing equivalent-measurement predicate; every matching lineage entry cites that one UsageRecord, with no per-attempt billing. A failed internal or Worker invocation with no usage remains a legal CapabilityCall. The Goal orchestrator's LLM CapabilityCall records the Turn it runs under instead of null. The route chain is neither an observation type nor a copy in observation `ext`; the retention owner keeps its existing model-observation and correlation semantics.

## Reason

On 2026-10-02, the coordinator put recommendations to the engineer after a read-only inventory and Consultant scrutiny. The engineer accepted them in Gateway routing proposal, Engineer Ruling 13: 「一次逻辑调用一行 (Recommended)」, translated as “One row per logical invocation (Recommended)”; 「派发前拒绝 (Recommended)」, translated as “Reject before dispatch (Recommended)”; 「不存 (Recommended)」, translated as “Do not store (Recommended)”; and 「全部按推荐 (Recommended)」, translated as “All as recommended (Recommended).” These are the coordinator's proposals accepted by the engineer, not unapproved Consultant authority.

A staging deployment showed pre-attempt failures reduced to route exhaustion without a lineage row. A public call without a Turn cannot write a Thread observation file, and an internal invocation whose members are all excluded never reaches model dispatch. An attempt-only observation home therefore cannot retain the selection facts Gateway already requires. One document on the existing CapabilityCall covers unavailable members and actual attempts without claiming a Provider call or usage where neither occurred.

The former public producer started calls inside member dispatch under the caller's request ID and the member's Provider attribution. A second member's start collided with immutable Provider attribution, preventing failover before that Provider was called. One start before the plan, null call-level Provider attribution for new multi-member invocations, and per-entry serving-member evidence remove that collision without weakening the measurement owner. Rejecting an already-used caller ID also prevents another Provider effect from being attached to a running or completed historical row.

The accepted design differs from the Consultant draft: account-slot identity is not stored, a reused caller request ID is refused rather than answered with a stored outcome, and the Consultant's proposed `payload.attempt` sentence is not adopted. This record defines no new meaning for that observation field. The document remains descriptive; authoritative consumption stays on UsageRecord, and no new durable record family or blind-public trace is introduced.

## Rejected Alternatives

- Split the home between observation `ext` for Turn-bound attempts and a call document for calls without a Turn. The column would still be needed for no-dispatch and no-Turn cases, while management would have to join two families and maintain a second writer for the same chain. A complete observation copy would also risk becoming a second capability ledger.
- Create one CapabilityCall per reached member. The public request-ID collision would remain until its producer converged toward one logical call; exclusion rows would be mistaken for Provider calls, disturb the not-counted rule and Worker provenance, and retries would multiply rows. A crash between starts would leave no single chain, requiring management to reconstruct it across calls.
- Store the account slot but omit it from the management projection. A Workspace record is not a safe home for that server-level identity, and no reader currently needs it; the engineer accepted non-storage instead.
- Answer a reused caller request ID with a stored outcome. The engineer accepted pre-dispatch `invalid_request` refusal for both running and terminal calls instead.

## Revisit When

Coordinator-proposed revisit conditions, not an Engineer ruling: a named reader needs the account slot, or an unattributed public consumer needs lineage after restart.

## Affected Owners

- docs/specs/20260526-llm_gateway_responses_api.md
- docs/specs/20260703-audit_usage_evidence_records.md
- docs/specs/20260921-work_data_retention_format.md
- docs/specs/20260704-capability_usage_gateway_foundation.md
