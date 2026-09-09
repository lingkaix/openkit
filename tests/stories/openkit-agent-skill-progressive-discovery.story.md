---
id: openkit-agent-skill-progressive-discovery
title: Create and confirm a Workspace through the packaged OpenKit Skill
persona: A team member organizing a new project in an existing OpenKit deployment
entrypoint: skill
default_tool: cursor-cli
timeout_seconds: 600
requires_real_provider: true
requires_real_codex: false
contracts: docs/specs/20260713-openkit_agent_skill_interface.md, docs/specs/20260909-persistent_deployment_acceptance.md
---

# OpenKit Skill Real Use

## Purpose

Prove that an independent Skill-capable Agent can create and confirm one named Workspace through the installed public interface on a persistent real deployment. The user asks for the resulting Workspace, not a sequence of CLI calls.

## Preconditions

- A supported Agent host provides Node.js 24, real model access and the packaged OpenKit Skill.
- An authorized persistent NanoCore deployment is reachable through the installed Skill connection, with existing protected credentials when required.
- The chosen project name is unique for this attempt and contains no private data.
- The Actor receives no source checkout, prior development conversation, story assertions or hidden answers.

## Setup

Install the packaged Skill in a fresh Agent host context. Retain its version/build identity and the deployment identity through the normal operator channel. Supply the usual connection securely. Give the Actor only its persona and this user goal, substituting the selected name: create a Workspace for the named project, verify it exists, and report its identity. Do not start or clear NanoCore for this attempt.

## User-visible Steps

The user asks for a new project Workspace. The Agent uses the installed public product interface to accomplish that goal and returns the resulting Workspace identity. Its discovery and operation sequence are unconstrained.

## Expected Outcomes

The requested Workspace exists and is readable through the public interface. The Agent accurately reports its identity, completes the requested scope and does not change unrelated resources.

## Deterministic Assertions

- Required, outside-in: the Actor's reported Workspace identity and name match a successful public Workspace read retained in the evidence package.
- Required, inside-out: the named Workspace record is present through the current authorized public read surface and has the requested name; the public Workspace owner decides this fact.
- Optional, outside-in: when doctor is invoked, its captured result reports the supported contract or a truthful incompatibility rather than a fabricated readiness claim.

## Evidence To Collect

The Actor entrypoint is the packaged Skill CLI; private database access, raw HTTP and source mutation are outside its allowed product tools. Retain host/tool provenance and prompt isolation as run-admission evidence, not product-result assertions. Hidden answers, a prescribed call sequence or unverifiable material isolation invalidate the Actor claim under the L6 owner; they do not turn an otherwise correct Workspace result into a product failure. Exclude credential values from all retained evidence.

Retain the verbatim Actor task prompt, Skill and deployment identity, permitted host/tool configuration, redacted Actor interaction observations, final response, and public Workspace read establishing the result. The independent Judge recomputes the claimed identity/name match. Discovery friction is a non-blocking observation, not an exact call-count assertion.

## Cleanup

Keep the deployment and its Provider configuration running. Remove only attempt-owned Agent-host temporary state when no longer needed. The created Workspace may remain as identifiable test data or be removed through an explicitly authorized public lifecycle operation after adjudication. Retain evidence under the L6 policy.

## Failure Triage Notes

A missing public operation, incorrect durable result or blocked supported flow is a product finding. Host/model failure and missing evidence retain the L6 owner's separate classifications. SSH diagnosis occurs after the Actor attempt and cannot repair its result into a pass. Reduce a confirmed deterministic defect into the lowest sufficient regression before a fresh attempt.
