# OpenShell Release Inputs

`release.json` identifies the supported official release and the exact external Gateway, Supervisor, and redistributed license inputs. Cargo owns the compiled SDK dependency. Packaging and NanoHost consume these identities directly.

`transport-assumptions.json` records the three stock holding points still used by the transport memory argument: the ForwardTcp response queue, both relay queues, and the Gateway pairing buffer. Queue capacities and chunk sizes belong together; a maximum chunk size alone does not bound queued bytes. Active frames, other transport holding, and process RSS are outside these entries.

`git-objects/` retains only the commit, tree paths, and three source blobs needed to bind those observations to the exact upstream source. Files contain raw Git object payloads and are named by their Git SHA-1 identity. The focused test reconstructs an isolated object database using Git, verifies object and source checksums, rejects stale release identity, and checks contribution arithmetic and citation ranges. It does not prove the semantic memory argument or replace independent source review and live qualification.

From the repository root, check this evidence with:

```bash
node --test tests/nanohost-transport-assumptions.test.mjs
```

Follow [OpenShell Upgrade](../../../docs/cookbooks/openshell-upgrade.md) for candidate preparation, the complete fast checks, opt-in stock transport checks, failure diagnosis, and adoption criteria. Do not add copied protobufs, SDK compile probes, upstream history, or a separate API inventory here.
