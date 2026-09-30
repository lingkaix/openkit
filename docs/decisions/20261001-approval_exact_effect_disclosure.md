---
status: Accepted
date: "2026-10-01"
decider: Engineer
---
# Approval Exact Effect Disclosure

## Decision

The engineer chose 「摘要卡片 + 授权详情」 (English: "summary card plus authorized detail") from the Consultant's recommended alternatives on 2026-10-01. Ordinary cards and shared Items carry a summary of at most 2 KiB and never raw captured arguments. Only the responsible user with current access to the request’s Thread receives complete canonical exact-effect detail, at most 512 KiB. Unavailable, oversized or undisclosable detail refuses grant with `409 approval_preview_unavailable`; denial and withdrawal remain available. The affected owners hold the exact behavioral criteria. Approval of this design does not establish implementation acceptance.

## Reason

The approver needs the complete immutable effect to authorize it, while shared Thread visibility does not authorize raw argument disclosure. Summary and authorized detail preserve exactness without copying sensitive work data into Items, attention lists, audit or usage. The engineer accepts the availability cost of refusing effects whose complete safe detail cannot fit the presentation limit.

## Rejected Alternatives

- Full raw arguments in ordinary cards and Items: widens sensitive-data disclosure and duplicates captured content into shared history.
- Redacted or truncated arguments with grant enabled: prevents inspection of every effect-bearing value without a domain-owned complete non-secret representation.
- Complete detail without a separate byte ceiling: leaves unbounded read/render resource costs; the engineer selected the bounded detail trade-off.
- Artifact, download or paged detail now: adds lifecycle and transport mechanisms without a demonstrated oversized effect that must be approvable.

## Revisit When

A real effect larger than 512 KiB must be approvable through paged or artifact detail, or an effect domain owner defines a complete non-secret representation.

## Affected Owners

- [Pending Requests](../specs/20260930-pending_requests.md#exact-effect-disclosure)
- [Human Attention And Intervention Model](../specs/20260531-human_attention_intervention_model.md)
