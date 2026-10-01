---
status: Accepted
date: "2026-10-01"
decider: Engineer
---
# App API Schemas Browser-Safe Subpaths

## Decision

On 2026-10-01, the coordinator asked the engineer whether to correct the stale Core Client Boundary dependency sentence to the current architecture or restore its literal protocol-and-Zod-only boundary. The engineer chose the option translated as Correct the specification to the current architecture. The coordinator applied the engineer's same-day ruling in [Specifications Prescribe Architecture, Not Implementation](20261001-specifications_prescribe_architecture_not_implementation.md) by framing the amendment as runtime-neutral, browser-safe reachability rather than a dependency allowlist: nothing reachable from the App API schema entry may import Node built-ins or use Node globals, enforced by the built-graph regression. The Core Client Boundary specification owns this invariant and retains its existing service, filesystem, Web UI, and transport exclusions. Concrete package and subpath choices belong in package metadata and local guides. The three native-environment schemas move off the config root to a browser-safe entry without a compatibility re-export.

## Reason

The literal dependency sentence had been stale since `2d209d2e` introduced the shared workspace-export dependency and the provider-subscription contract later used its own browser-safe subpath. The governing intent is runtime-neutral and browser-safe schema reuse. Restoring the literal sentence would move runtime configuration concepts into stable Core protocol merely to satisfy a stale package list. The invariant preserves architecture and lets package entry choices evolve during implementation. Narrow entries retain the canonical validators while excluding server and Worker control code from the browser graph.

## Rejected Alternatives

Restoring the literal two-dependency boundary was not selected. Buffer polyfills, lazy Node initializers, and Vite shims were excluded by the build brief because they leave Node-only code reachable from the browser.

## Revisit When

A browser consumer needs a configuration concept that cannot be made browser-safe, or an admitted subpath stops being browser-safe.

## Affected Owners

- [Core Client Boundary](../specs/20260528-core_client_boundary.md).
