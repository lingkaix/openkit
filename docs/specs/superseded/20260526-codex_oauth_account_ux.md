# Codex OAuth Account UX Recovery

Status: Superseded
Implementation: N/A
Status Changed: 2026-06-28
Current Guidance: `docs/specs/20260526-codex_chatgpt_subscription_login.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

Codex ChatGPT Subscription Login absorbed account slots, sanitized diagnostics, scoped login/logout actions, provider binding, and route ownership into one accepted contract. This recovery note lost authority because account UX and server behavior now evolve together under that active owner.

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
