# models.dev Catalog Package

Read `README.md` first. This file contains only local agent execution rules for the models.dev catalog package.

## Local Agent Rules

- Keep this package limited to externally sourced `models.dev` catalog snapshots and validation helpers.
- Runtime boot must not fetch live `models.dev` data.
- Refresh snapshots only through explicit maintenance work with a reviewed snapshot diff.
- Reconcile NanoCore provider templates whenever provider ids or starter model ids change upstream.
- Keep snapshot metadata, checksums, and provider mappings in sync.
