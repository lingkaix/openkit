# Pi Worker Image

This image packages the shared OpenKit development environment, its inherited persistent `/workspace` and `/sandbox` layout, the generic worker shim, the static Pi adapter, and `@earendil-works/pi-coding-agent@0.85.1` for governed OpenShell execution.

The authored Pi AgentManifest selects this image, the Gateway logical `grok` preference, the required trusted worker inference relay, and exact GitHub read, npm download, and PyPI download grants. The adapter projects its admitted logical model and effective parameters into one ephemeral native `models.json` for the fixed `inference.local` target. The descriptor references the distinct inference-token environment variable; no upstream subscription credential enters Pi. The image no longer enables the historical direct Anthropic credential passthrough. The [Pi Worker Adapter owner](../../docs/specs/20260716-pi_worker_adapter.md) defines this bounded route and its isolation flags.

The smoke opens a pending Pi binding with separate control, retained state, and Turn directories, then checks the adapter-produced descriptor, exact JSON-mode argv with the selected absent `--session` path, private file mode, native offline model registration, pending inspection, control-only close, and generic shim dry run using a synthetic inference token. Its 360K context and 32K output values are fixture inputs, not physical model-limit claims. It makes no inference call and proves no live relay or Task lifecycle. The repository manifest remains disabled until a real bounded inference Turn provides the required proof; neither an image build nor smoke alone enables default dispatch.

Run `node --test containers/worker-pi/smoke.test.mjs` and `bash -n containers/worker-pi/smoke.sh` for focused static checks. These inspect the image definition, manifest and smoke source; they do not substitute for executing the image smoke.

Build and smoke it with `scripts/docker/build-image.sh worker-pi` and `scripts/docker/smoke-image.sh worker-pi`.
