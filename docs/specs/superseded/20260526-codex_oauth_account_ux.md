# Codex OAuth Account UX Recovery

Status: Superseded

Superseded: 2026-06-28. This file is retained as historical context and is not an active implementation or release-readiness spec.

Superseded note: The 20260529 cleanup spec removes workspace snapshot repair and the top-level `oauth.openaiCodex` diagnostics mirror.

## Current Contract

NanoCore and the web settings UI keep Codex OAuth account diagnostics visible through `oauth.openaiCodexAccounts`.

Each account row carries explicit `accountSlotId`, `isDefault`, `boundProviderIds`, and sanitized login state.

Persisted workspace snapshots that contain removed worker-shaped fields now fail with a clear load error.

Diagnostics no longer publish a single top-level Codex OAuth status row, so account-list state is the only current diagnostics source for Codex OAuth accounts.

## Coverage

Coverage belongs in NanoCore and web tests for account-scoped OAuth routes, duplicate account-slot `409` errors, degraded startup rendering, visible successful and failed accounts, inline duplicate and invalid slot errors, and preservation of failed account-creation inputs.
