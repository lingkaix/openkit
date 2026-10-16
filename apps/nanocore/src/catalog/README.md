# Resource Catalog

`resource-catalog.ts` is the single reader, immutable-content owner and compare-and-set publisher for scope-owned Skill, MCP and plugin catalogs. Server and Workspace use the same document layout and writer. Skill and plugin import remain Workspace operations in this feature; their retained arrays are preserved in both document scopes.

Trusted `ResourceCatalogOwner` arguments select Server or exact Workspace storage. `loadResourceCatalog` validates that scope agrees with its path and returns known fields. Retained history stays private so normal rewrites preserve descriptive additions. Omitted scope is admitted only at a Workspace path and written explicitly at the next authorized CAS. Catalog path lookup never creates or revives a Workspace. Reads never migrate bytes; immutable tree/configuration identity and existing Workspace effective MCP identity stay unchanged.

MCP create, stage, select and binding mutations take an explicit owner. Server administration remains in `../administration/server-mcp-operations.ts`; this module owns no user authorization or Vault effects. Server management never creates mutable Server process-data directories. Bindings retain their stable data key; the Gateway materializes shared mutable data inside each consuming Workspace.

`composeWorkspaceMcpCatalog` projects current Server supply without copying it into a Workspace. Any local entry, including inactive/removed entries, suppresses a same-id shared entry. Exact `mcp.disabledServerIds` belongs to the consuming Workspace. Only canonical shared projections add Server origin to effective digest identity. Callers must still recheck current selection, grant and audience at effect boundaries.

Run the focused catalog and shared flow tests with `pnpm --filter @openkit/nanocore exec vitest run src/catalog/resource-catalog.test.ts src/catalog/server-scope.test.ts src/server-shared-mcp.test.ts --maxWorkers=1`. Follow the parent [NanoCore guide](../../README.md) for checks and toolchain rules.
