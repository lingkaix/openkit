# OpenShell Schema Snapshot Package

Read `README.md` first. This file contains only local agent execution rules for the OpenShell schema snapshot package.

## Local Agent Rules

- Treat this legacy package and its source, tests, snapshots, and metadata as immutable until deletion with its current consumers at cutover.
- Do not refresh, repair, regenerate, or extend the snapshot or its conformance helpers.
- Do not add NanoCore worker backend business logic or OpenKit public protocol schemas here.
- Runtime boot must not fetch live OpenShell schemas or CLI metadata.
- Keep the target OpenShell pin with the consuming NanoHost application, not in this package.
