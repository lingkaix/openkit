---
status: Superseded
implementation: N/A
status-changed: 2026-06-28
current-guidance: "`docs/specs/20260721-provider_subscription_accounts.md`"
decision-evidence: "`docs/specs/20260721-provider_subscription_accounts.md`"
---
# Codex OAuth Account UX Recovery

## Lifecycle Reason

Codex ChatGPT Subscription Login first absorbed account slots, sanitized diagnostics, scoped login/logout actions, provider binding, and route ownership; Provider Subscription Accounts now owns the provider-neutral replacement. This recovery note remains historical because account UX and server behavior evolve together under that active owner.

## Retention Reason

This document preserves the original diagnostics recovery problem, removed snapshot-repair behavior, and account-row expectations so maintainers can audit the migration without treating the recovery note as the current login contract.

Superseded note: The 20260529 cleanup spec removes workspace snapshot repair and the top-level `oauth.openaiCodex` diagnostics mirror.

## Current Contract

NanoCore and the web settings UI keep Codex OAuth account diagnostics visible through `oauth.openaiCodexAccounts`.

Each account row carries explicit `accountSlotId`, `isDefault`, `boundProviderIds`, and sanitized login state.

Persisted workspace snapshots that contain removed worker-shaped fields now fail with a clear load error.

Diagnostics no longer publish a single top-level Codex OAuth status row, so account-list state is the only current diagnostics source for Codex OAuth accounts.

## Coverage

Coverage belongs in NanoCore and web tests for account-scoped OAuth routes, duplicate account-slot `409` errors, degraded startup rendering, visible successful and failed accounts, inline duplicate and invalid slot errors, and preservation of failed account-creation inputs.
