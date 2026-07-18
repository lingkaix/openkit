# Capability Discovery Map

Load this reference when the user's intent does not clearly identify a capability group or when an expected operation cannot be found.

## Discover an operation

1. Run `scripts/openkit doctor` before networked product work.
2. Search with a short product noun and verb, such as `workspace list`, `goal start`, or `vault status`.
3. Search a broader capability-group term when the first query returns no suitable match.
4. Describe the selected operation and inspect its source, mutation flag, sensitivity, required access, and strict flat input schema.
5. Call it with one JSON object through stdin, then re-read the owning durable state.

Use this intent map to choose search terms; do not treat it as the authoritative operation inventory:

| User intent | Search terms | Load first |
| --- | --- | --- |
| Connect, diagnose, or bootstrap | `connection`, `doctor`, `bootstrap`, `credential` | [setup.md](setup.md) |
| Manage workspace resources | `workspace`, `resource`, `data source` | [loop.md](loop.md) |
| Link repositories or perform Git work | `repository`, `git`, `push`, `sync` | [loop.md](loop.md) or [administration.md](administration.md) |
| Converse or delegate bounded work | `chat`, `task`, `thread`, `turn` | [loop.md](loop.md) |
| Plan and execute multi-step work | `goal`, `plan`, `step`, `review` | [loop.md](loop.md) |
| Resolve human attention | `attention`, `approval`, `question`, `decision` | [loop.md](loop.md) |
| Inspect outputs and proof | `artifact`, `evidence`, `audit`, `usage` | [loop.md](loop.md) |
| Retrieve or govern knowledge | `knowledge`, `claim`, `conflict`, `context`, `proposal` | [knowledge.md](knowledge.md) |
| Recover interrupted work | `interrupted`, `checkpoint`, `retry`, `recovery`, `stale` | [recovery.md](recovery.md) |
| Configure worker runtime | `runtime`, `configuration`, `session` | [administration.md](administration.md) |
| Administer secrets and grants | `vault`, `grant`, `injection`, `rebind` | [administration.md](administration.md) |
| Schedule recurring work | `automation`, `schedule`, `trigger` | [administration.md](administration.md) |
| Move or protect workspace data | `backup`, `export`, `import`, `restore`, `portability` | [administration.md](administration.md) |
| Administer access | `access token`, `revoke`, `credential` | [administration.md](administration.md) |

## Respect coverage boundaries

Expect the catalog to expose public end-user and operator behavior from App API, public Core projections, and the two local credential operations. Expect private NanoCore internals, raw storage, arbitrary HTTP, arbitrary shell, worker callbacks, provider gateways, and worker-side capability supply to remain unavailable.

Treat a missing operation as a coverage or product-boundary fact, not permission to call a private route. Report the missing user intent and stop; do not invent an identifier or bypass the public Core Client.
