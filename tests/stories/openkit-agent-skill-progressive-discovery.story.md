---
id: openkit-agent-skill-progressive-discovery
title: Create and confirm a Thread through the packaged OpenKit Skill
persona: A team member organizing a new project in an existing OpenKit deployment
entrypoint: skill
default_tool: cursor-cli
timeout_seconds: 600
requires_real_provider: false
requires_real_codex: false
contracts: docs/specs/20260713-openkit_agent_skill_interface.md, docs/specs/20260909-persistent_deployment_acceptance.md
---

# OpenKit Skill Real Use

## Purpose

Prove that an independent Skill-capable Agent can create and confirm one named Thread in an authorized Workspace through the installed public interface on a persistent real deployment. The user asks for the resulting Thread, not a sequence of CLI calls.

## Preconditions

- A supported Agent host provides Node.js 24, real model access and the packaged OpenKit Skill.
- The independent Actor uses a real model to discover and operate the Skill. Thread CRUD itself does not need a NanoCore Provider or Codex Worker, so both product dependency flags are false. Retain the actual Actor host, model identity and inference-session provenance.
- An authorized persistent NanoCore deployment is reachable through the installed Skill connection. A normal user has owner or editor membership in the supplied Workspace, and the Actor has a Workspace-bound credential permitting mutation in that Workspace. A server-admin or workspace-readonly token does not satisfy this precondition.
- The chosen project name is unique for this attempt and contains no private data.
- The Actor receives no source checkout, prior development conversation, story assertions or hidden answers.

## Setup

Install the packaged Skill in a fresh Agent host context. Retain its version/build identity and the deployment identity through the normal operator channel. Supply the usual connection securely; provision the normal user and Workspace through supported session APIs before admission if needed. Give the Actor only its persona and this user goal, substituting the selected name and Workspace identity: create a Thread for the named project in the supplied Workspace, verify it exists, and report its identity. Do not start or clear NanoCore for this attempt.

## User-visible Steps

The user asks for a new project Thread in the supplied Workspace. The Agent uses the installed public product interface to accomplish that goal and returns the resulting Thread identity. Its discovery and operation sequence are unconstrained.

## Expected Outcomes

The requested Thread exists in the supplied Workspace and is readable through the public interface. The Agent accurately reports its identity, completes the requested scope and does not change unrelated resources.

## Deterministic Assertions

- Required, outside-in: the Actor's reported Thread identity and name match a successful public Thread read retained in the evidence package, within the supplied Workspace.
- Required, inside-out: the named Thread record is present through the current authorized public read surface and has the requested name and Workspace; the public Thread owner decides this fact.
- Optional, outside-in: when doctor is invoked, its captured result reports the supported contract or a truthful incompatibility rather than a fabricated readiness claim.

## Evidence To Collect

The Actor entrypoint is the packaged Skill CLI; private database access, raw HTTP and source mutation are outside its allowed product tools. Retain host/tool provenance, prompt isolation and redacted credential scope, mutation posture and Workspace binding as run-admission evidence, not product-result assertions. Hidden answers, a prescribed call sequence or unverifiable material isolation invalidate the Actor claim under the L6 owner; they do not turn an otherwise correct Thread result into a product failure. Exclude credential values from all retained evidence.

Retain the verbatim Actor task prompt, Skill and deployment identity, permitted host/tool configuration, redacted Actor interaction observations, final response, and public Thread read establishing the result. The independent Judge recomputes the claimed identity/name/Workspace match. Discovery friction is a non-blocking observation, not an exact call-count assertion.

## Cleanup

Keep the deployment, supplied Workspace and Provider configuration running. Remove only attempt-owned Agent-host temporary state when no longer needed. The created Thread may remain as identifiable test data or be removed through an explicitly authorized public lifecycle operation after adjudication. Retain evidence under the L6 policy.

## Failure Triage Notes

A missing public operation, incorrect durable result or blocked supported flow is a product finding. Host/model failure and missing evidence retain the L6 owner's separate classifications. SSH diagnosis occurs after the Actor attempt and cannot repair its result into a pass. Reduce a confirmed deterministic defect into the lowest sufficient regression before a fresh attempt.
