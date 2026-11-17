# Policy Kernel

`@openkit/policy-kernel` is the shared OpenKit policy kernel.

The package follows NGAC and Policy Machine theory as a standards discipline. OpenKit may implement only a subset of NGAC, but every implemented NGAC concept must match NGAC definitions, standard terminology, and described semantics. Product-friendly names belong in adapters, not in kernel concept definitions.

This package is not a complete NGAC standards implementation and must not be presented as one. It evaluates a strict subset of caller-supplied authorization facts. [Policy](../../docs/core/policy.md) owns product Policy.

This package does not know about NanoCore routes, MCP tools, Web UI, vault secret values, Knowledge Store content, audit persistence, OpenShell policies, or runtime adapters.

## Current Implemented Surface

The current package implements:

- NGAC policy element records for users, objects, user attributes, object attributes, and policy classes
- NGAC assignment containment traversal and relation validation
- NGAC process-to-user mapping for process-mediated access requests
- operation-to-required-access-right evaluation
- association-based access right grants from user attributes to target attributes
- user, process, and user-attribute prohibition restrictions with conjunctive and disjunctive ranges
- access requests
- allow or deny access decisions
- decision traces
- local conformance fixtures for the implemented NGAC subset

A matching prohibition determines the deny reason before a missing privilege, including when the request has no granting association. Policy and request validation still run first.

The current implementation is an NGAC-aligned subset, not a full NGAC implementation. It intentionally accepts caller-supplied immutable policy facts and does not implement policy storage, policy mutation, PEP/PDP/PAP/PIP/RAP/EPP entities, administrative routines, obligations, or lifecycle cleanup for process-terminated prohibitions.

The implemented list above is the package surface. It is not a second target inventory.

## Not Yet Implemented

These NGAC concepts are relevant but not currently implemented:

- administrative operations
- obligations
- dynamic policy mutation
- delegated administration
- policy review functions
- lifecycle mutation that automatically removes process-based prohibitions when the associated process terminates
- third-party or standards-body conformance fixture suites for the implemented subset

[#375](https://github.com/lingkaix/openkit/issues/375) and [#280](https://github.com/lingkaix/openkit/issues/280) are related product work. They are not an administration API in this package.

## Outside this package

These areas stay outside this package:

- exposing PEP, PDP, PAP, PIP, RAP, or EPP as public OpenKit product concepts
- implementing the full NGAC functional architecture as public App API, MCP, or Web UI surfaces
- exposing raw NGAC graph internals directly to users or agents
- making OpenShell policy YAML part of the canonical NGAC model
- implementing NGAC features with no OpenKit product need unless they become necessary to keep an implemented concept standards-compatible

## Commands

- `pnpm --filter @openkit/policy-kernel test`
- `pnpm --filter @openkit/policy-kernel typecheck`
- `pnpm --filter @openkit/policy-kernel build`
- `pnpm --filter @openkit/policy-kernel lint`
