# OpenShell Schema Snapshot Package

Read `README.md` first. This file contains only local agent execution rules for the OpenShell schema snapshot package.

## Local Agent Rules

- Keep this package limited to pinned OpenShell boundary snapshots and conformance helpers.
- Do not add NanoCore worker backend business logic here.
- Do not add OpenKit public protocol schemas here.
- Runtime boot must not fetch live OpenShell schemas or CLI metadata.
- Refresh snapshots only through explicit maintenance work with a reviewed snapshot diff.
- Keep `metadata.json` checksums in sync with snapshot artifacts.
