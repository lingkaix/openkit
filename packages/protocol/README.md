# @openkit/protocol

`@openkit/protocol` defines shared OpenKit Core schemas, request payloads, event envelopes, and JSON Schema outputs for product surfaces, App API clients, MCP facades, and runtime adapters that project into stable OpenKit protocol records.

This package is the machine-readable source of truth for stable shared protocol records. App-specific read models, transport routes, and runtime-native payloads remain projections outside the package.

## Scope

- Core protocol records, commands, events, errors, and conformance fixtures.
- TypeScript and Zod schema sources.
- Generated JSON Schema outputs derived from the Zod source.

## Commands

- `pnpm --filter @openkit/protocol test`
- `pnpm --filter @openkit/protocol typecheck`
- `pnpm --filter @openkit/protocol build`
