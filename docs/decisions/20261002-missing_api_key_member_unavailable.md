---
status: Accepted
date: "2026-10-02"
decider: Engineer
---
# Missing API Key Makes A Route Member Unavailable

## Decision

A Gateway route member whose Provider profile requires an API key that is not configured is an unavailable member, like an absent profile, a non-dispatchable profile, an absent or logged-out bound account, or a delisted model. It is hidden from discovery when no other member is available, contributes no reasoning-effort levels, is skipped at selection without a Provider attempt, and is named by a reload warning. Whether a key is configured is judged from the credential reference's configuration and non-secret Vault reference metadata, without resolving Vault material, recording Vault use, or a network request. A configured key that the Provider rejects, that a locked Vault cannot release, or that disappears after selection keeps its attempt-time classification. The Gateway Responses API specification owns the rule.

## Reason

On 2026-10-02 the coordinator asked whether a member whose Provider lacks its API key counts as available, after an implementation slice had treated a missing key only as an attempt failure. The engineer ruled: 「第二个，缺少API Key的成员不算可用」, translated as “Second, a member that lacks an API key does not count as available.”

The engineer gave the ruling without a separate reason. In the coordinator's framing of the question, a member without its key cannot serve any request: advertising it would publish a logical model or effort level that every request then fails, and every request would spend a failed attempt before reaching a usable member. Treating the missing key as missing supply makes discovery, effort levels and diagnostics truthful, including for a fresh Data Root whose template Providers have no keys yet.

## Rejected Alternatives

- Keep a member with a missing key available and let dispatch classify the attempt as `auth_rejected`, the earlier implementation clarification. Discovery and effort levels would advertise supply that cannot serve a request.

## Revisit When

Coordinator-proposed revisit conditions, not an Engineer ruling: configured-key presence can no longer be judged without resolving secret material, or Providers gain an accepted keyless mode whose requirement cannot be read from configuration.

## Affected Owners

- docs/specs/20260526-llm_gateway_responses_api.md
