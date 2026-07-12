# Remove Historical Compatibility Layers

Status: Superseded
Implementation: N/A
Status Changed: 2026-06-28
Current Guidance: `docs/specs/README.md`, `docs/specs/AGENTS.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`
Date: 2026-05-29


## Lifecycle Reason

The canonical internal-development compatibility rule and each active owning spec absorbed the durable prohibition on repository-owned compatibility layers. This cleanup campaign lost authority because completed removals and current invariants must live with their permanent owners rather than a one-time remediation spec.

## Retention Reason

This document preserves the original compatibility debt inventory, breaking cleanup scope, and migration evidence so future audits can explain removed aliases and defaults without using the campaign as an active contract.

Completion amendment: The cleanup scope includes `scripts/docker/**`, staging UI e2e fixtures, NanoCore data templates, accepted-spec amendments, `ApiErrorSchema.protocolVersion`, and scan allowlists. Staging authored config must use `secretRef`; inline provider credentials in existing staging config fail clearly instead of being repaired.

## Summary

OpenKit is in internal development, so repository-owned backward compatibility layers must be removed instead of preserved.

This spec records the breaking cleanup that removes historical aliases, permissive schema defaults, unscoped OAuth routes, old diagnostics fields, persisted snapshot repair, inline-secret compatibility, and outdated runtime names.

The completion pass also removes the remaining staging and template documentation paths that still described inline credentials as current operator guidance.

The cleanup does not remove product capabilities such as OpenAI-compatible APIs, provider failover, provider fallback, SPA fallback, pnpm deployment flags, Tailwind upstream warnings, archived working logs, temporary research material, or upstream generated Codex schema text.

## Decisions

- Delete protocol aliases whose only purpose is historical compatibility.
- Require current protocol records to carry explicit fields instead of accepting missing historical fields.
- Treat persisted store snapshots, runtime config files, and provider profiles that still use removed OpenKit-owned fields as invalid input.
- Remove unscoped Codex OAuth routes and client methods.
- Require every Codex OAuth provider profile to declare an explicit account slot id.
- Keep the `default` account slot only as a normal explicit slot id.
- Remove old single-view diagnostics fields and keep only current list-shaped diagnostics.
- Rename current Codex materializer APIs so they do not carry outdated names.
- Update current docs and accepted specs to state the strict internal-development contract.

## Public Contract Changes

`@openkit/protocol` no longer exports `WorkspaceSchema`, `StartTurnRequestSchema`, `StartTurnResponseSchema`, `GetTurnResponseSchema`, or `ValidatedItemDeltaEventSchema`.

Protocol consumers must use `WorkspaceRecordSchema`, `SubmitTurnInputRequestSchema`, and `TurnSchema`.

`PROTOCOL_VERSION` is `0.3.0`.

`Turn.configVersion` is required and nullable.

`CommandExecutionItemSchema.output` is a required string.

Strict and forward-compatible `item-delta` events require `itemType`.

Strict and forward-compatible SSE envelopes require `protocolVersion`.

App diagnostics no longer include `defaultProvider` or `oauth.openaiCodex`.

App diagnostics keep `defaultProviders` and `oauth.openaiCodexAccounts` as the current shapes.

Codex OAuth no longer supports unscoped `GET /status`, `POST /start`, `POST /cancel`, or `POST /logout` routes.

Codex OAuth client and manager calls that operate on one account require an explicit `accountSlotId`.

Codex OAuth provider profiles must include `extensions.openkit.codexOAuth.accountSlotId`.

Runtime config no longer accepts top-level `dataRoot`, provider inline secret fields, `agent.provider.inline`, or the removed inline-secret policy.

## Persistence And Migration

There is no migration for old persisted data in this cleanup.

If an old snapshot, old runtime config file, or old provider profile is loaded, OpenKit must fail clearly at the boundary where the invalid input is parsed.

NanoCore must not silently map the removed worker default field to `defaultAgentId`.

NanoCore must not silently map the removed workspace resource workers field to `workspaceResources.agents`.

Protocol validators must not fill missing `configVersion`, `output`, `itemType`, or `protocolVersion`.

`ApiErrorSchema` must reject error payloads without `protocolVersion`; emitters and fixtures must stamp `PROTOCOL_VERSION` explicitly.

## Implementation Order

1. Update `packages/protocol` tests, schemas, conformance records, generated JSON Schema, and consumers of removed aliases.
2. Update `packages/config-schema` tests and schemas to reject removed config and inline-secret inputs.
3. Update `packages/app-api-schemas` tests and schemas to reject removed diagnostics shapes.
4. Update `packages/core-client` tests and APIs to remove unscoped OAuth methods and protocol aliases.
5. Update `apps/nanocore` routes, managers, store loading, runtime config wiring, runtime materializer names, tests, and diagnostics.
6. Update `apps/web` diagnostics and protocol consumers to use current scoped shapes only.
7. Update current docs and accepted specs, while leaving archived working logs, temporary files, and upstream generated schema text unchanged.

## Test Gates

- Protocol tests must reject missing `configVersion`, missing command execution `output`, missing item delta `itemType`, and missing SSE `protocolVersion`.
- Protocol tests must prove removed alias exports are absent from the public package surface.
- Config-schema tests must reject removed `dataRoot`, raw provider secret fields, `agent.provider.inline`, the removed inline-secret policy, and unknown top-level config keys.
- App API schema tests must reject `defaultProvider` and `oauth.openaiCodex`.
- Core-client tests must cover only account-scoped Codex OAuth routes.
- NanoCore tests must cover account-scoped Codex OAuth routes, explicit provider slot requirements, invalid removed-field store snapshots, diagnostics without old fields, and renamed Codex launch materializer APIs.
- Web tests must cover diagnostics rendering and actions without unscoped OAuth fallbacks.
- Docker staging tests must cover `secretRef` seed config, raw `apiKey` rejection, and host-env secret injection into agent runtime environments.
- Web staging e2e must assert `diagnostics.defaultProviders.core` and `diagnostics.defaultProviders.gateway`, and must reject `diagnostics.defaultProvider`.
- Final repository scan must leave only explicitly allowed non-historical compatibility terms outside excluded archive, temporary, and upstream generated paths.

## Documentation

Current protocol, App API, runtime config, NanoCore, and compatibility docs must describe the strict internal-development contract.

Accepted specs that previously described historical repairs or removed defaults must update their current-contract prose directly. When historical context is still useful, keep it only as an explicit note that does not preserve the old behavior.

## Final Scan Allowlist

The post-cleanup legacy scan may keep only these classes of matches: current product capabilities such as `client.oauth.openaiCodex`, `oauth.openaiCodexAccounts`, `defaultProviders`, current `defaultProviderId` config fields, resolved runtime `apiKey` fields, Codex upstream `apiKey` auth mode, OpenAI-compatible API capability, provider failover and fallback, rejection tests, archived working logs, explicit rejection text for removed inputs, Tailwind upstream warnings, and pnpm's required `--legacy` deploy flag.
