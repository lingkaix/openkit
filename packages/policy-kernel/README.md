# Policy Kernel

`@openkit/policy-kernel` is the shared OpenKit policy kernel.

The package follows NGAC and Policy Machine theory as a standards discipline. OpenKit may implement only a subset of NGAC, but every implemented NGAC concept must match NGAC definitions, standard terminology, and described semantics. Product-friendly names belong in adapters, not in kernel concept definitions.

This package is not a complete NGAC standards implementation and must not be presented as one. It is intended to become a strict, verified NGAC subset evaluator for OpenKit authorization facts.

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

The current implementation is an NGAC-aligned subset, not a full NGAC implementation. It intentionally accepts caller-supplied immutable policy facts and does not implement policy storage, policy mutation, PEP/PDP/PAP/PIP/RAP/EPP entities, administrative routines, obligations, or lifecycle cleanup for process-terminated prohibitions.

## Target Implemented NGAC Subset

The package target is to implement these NGAC concepts as a strict subset:

- users, objects, user attributes, object attributes, and policy classes as policy elements
- assignment relation over valid NGAC policy element pairs
- assignment containment closure
- association relation as access right allocation from user attributes to attributes
- operation-to-required-access-right evaluation
- derived privilege checks from assignments, associations, access rights, and policy-class semantics
- user, process, and user-attribute prohibition restrictions over access rights
- access request adjudication returning allow or deny
- decision traces for development and redacted audit projection

## Not Yet Implemented

These NGAC concepts are relevant but not currently implemented:

- administrative operations
- obligations
- dynamic policy mutation
- delegated administration
- policy review functions
- lifecycle mutation that automatically removes process-based prohibitions when the associated process terminates
- third-party or standards-body conformance fixture suites for the implemented subset

## No Current Plan

These NGAC areas have no current implementation plan:

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
