# Repository Scripts

Root `package.json` owns the command surface and `docs/toolchain.md` owns setup and execution placement. These scripts implement those commands; they do not supply design authority.

## Release Inputs And Verification

`release-preflight.mjs` validates the selected release inputs and the schema-version-2 NanoHost capability profile. `package-release-assets.mjs` reads checkout-owned inputs from the selected Git revision and produces the controlled release archives. NanoHost packaging selects `linux/amd64` and `linux/arm64` from the distribution table in `lib/nanohost-elf.mjs`; it bundles exact `host-manifest.json` bytes, profile id and digest, product commit, and libc symbol-version requirements derived from both ELF executables. `verify-nanohost-release.mjs` checks the archive tree, checksums, checkout-owned bytes, provenance, ELF and derived requirements, then performs a contained staging install.

Run `pnpm release:preflight -- --tag <tag>` and `pnpm release:package -- --tag <tag>` through the release cookbook. Release and pre-release tag CI runs target-native real-host qualification before publication under the release and NanoHost specifications; pull-request and manual gates do not run it.

For a complete NanoHost release, supply `--nanohost-amd64-binary`, `--nanohost-arm64-binary`, `--openshell-amd64-gateway-archive`, `--openshell-arm64-gateway-archive`, `--openshell-license`, and `--openshell-notices` to the existing packager. Gateway archive and extracted executable identities come from `gateway.targets["linux/<architecture>"]` in the schema-version-2 OpenShell release pin. The shared checksum covers the operations Skill and both NanoHost archives. Tag packaging installs checkout dependencies before invoking the packager and downloads the accepted inputs with the test image's built-in Node fetch. Post-publication asset inspection also installs checkout dependencies inside that image; its Node 24 verifier runs operations discovery from the extracted envelope outside the checkout while Docker and GitHub Release access remain on the host.

## NanoHost Static Checks

After checking the outer archive checksum, extract the NanoHost archive beside its original `.tar.gz`, then run the bundled `./install.sh --check-host`. The checker reads only bundled checksum-verified inputs and verifies that the adjacent archive contains those exact bytes. Checking and installation, including staging verification, require Python 3.8 or later with its standard library at `/usr/bin/python3`, with isolated imports and bytecode writes disabled. It is not a NanoHost service runtime dependency; missing or unusable inspection returns one bounded `cannot-check` result and blocks installation. Every static probe has a deadline, and no checker mode provisions packages or invokes a service lifecycle command.

Each installer invocation bounds interpreter execution and result collection together in the existing POSIX shell and verifies bundled inputs once through that path; no shell checksum prepass runs before it. The checker emits one JSON object and a newline with a hard verdict and separate combined-deployment resource recommendation. `./install.sh --check` and live installation consume the same result while retaining their installation-disposition output. `DESTDIR=/new/canonical/path ./install.sh` verifies bundled inputs and stages only the three fixed payloads, with the existing host-check exemption.

See [Deployment Host Requirements](../docs/specs/20260909-deployment_host_requirements.md), [NanoHost Runtime And Transport](../docs/specs/20260802-nanohost_runtime_and_transport.md), and the [Release Cookbook](../docs/cookbooks/release.md) for the owners and qualification boundary.
