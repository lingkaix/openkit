# Agent Roles

This directory holds one harness-neutral contract per registered agent role. Each contract states the question the role answers, what it reads, what it may write, its capability tier, its leading words, and what it cannot accept. The Role Contracts section of docs/documentation-model.md owns the type; docs/change-execution.md owns which roles exist, when they are composed, and the position and function model.

## Roles

| Role | Question it answers | Minimum tier |
| --- | --- | --- |
| [researcher](researcher.md) | What does independent external evidence say? | standard |
| [test-author](test-author.md) | What failing check derives from the accepted behavior? | standard |
| [builder](builder.md) | What is the smallest coherent change inside the owned paths? | standard, or fast for bounded work |
| [writer](writer.md) | Is this text clear, consistent with the glossary, and free of filler, with every criterion intact? | standard |
| [reviewer](reviewer.md) | Is the actual result correct, complete, simple, and aligned with its owners? | the producer's tier or higher |
| [consultant](consultant.md) | Is the work worth doing and the route reasonable and feasible, before a direction-bearing commitment and at fresh direction checks? | frontier |
| [auditor](auditor.md) | Do intent, decisions, authority, implementation, and behavior still agree? | frontier |

The primary is a position, not a file here: docs/change-execution.md states what the primary of a scope does. Any function above can be performed by the primary itself.

## Using A Role

A primary chooses a function from the table above when it scopes, plans, and dispatches work, and hands the role over with a dispatch prompt that names the role file; docs/agent-harnesses.md owns the prompt template, the model bound to each tier, and what each harness can enforce. The dispatched agent reads root AGENTS.md, then its role file, before task work. No harness keeps a copy or adapter of a role: every runtime reads the same file here, and a runtime without the checkout receives the file's text in its dispatch.

## Changing A Role

Edit the role file. A role file ranks below the governance documents it applies, so resolve a conflict by correcting the role file. Adding or removing a role is a change to docs/change-execution.md first, then to this index and, where a tier or dispatch need changes, docs/agent-harnesses.md in the same change. Role files use the vocabulary of docs/glossary.md.
