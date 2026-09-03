# OpenShell Pin Manifest

This manifest records the exact OpenShell boundary consumed by NanoHost and the observations that cannot be frozen by the client source pin and Cargo lockfile alone.

The source observation used a clean, complete, non-shallow checkout of the immutable `v0.0.99` tag at commit `8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032`.

The four interface-definition digests below were calculated from the vendored repository bytes and those bytes were compared with the corresponding files at the pinned checkout.

The release-archive and extracted-payload digests were observed on the declared A1 Linux aarch64 execution host, where SHA-256 was recomputed from the downloaded bytes, each archive digest was verified against its publisher-supplied `*-checksums-sha256.txt` entry, and the extracted `openshell` and `openshell-gateway` executables each self-reported version `0.0.99`. The Supervisor is instead the exact published OCI index plus its two platform manifests recorded below; the pinned source verifies that each selected image's `/openshell-sandbox` payload is static musl.

The NanoHost Distribution also consumes `LICENSE` and `THIRD-PARTY-NOTICES` from that same clean pinned checkout. Their retained SHA-256 values were recomputed from both the checkout bytes and the commit-bound upstream downloads before their fixed bundle paths were admitted.

```json
{
  "source": {
    "tag": "v0.0.99",
    "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032",
    "checkout": {
      "complete": true,
      "shallow": false,
      "clean": true,
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    }
  },
  "interfaceDefinitions": [
    {
      "path": "apps/nanohost/openshell-pin/proto/openshell.proto",
      "checksum": "sha256:9eb31eff5bd650b034d6114266e0fd24077d406f33e15a2d79e79c1f05eed2c5",
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "path": "apps/nanohost/openshell-pin/proto/sandbox.proto",
      "checksum": "sha256:752d871b3646a0b8af3f157a601126eb6166df2afec64a51ad46f975ee7c881f",
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "path": "apps/nanohost/openshell-pin/proto/datamodel.proto",
      "checksum": "sha256:5b09546edd1e0bb706526c932332861ef7a0ec6b2f074a185421d4f2cc6c4abc",
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "path": "apps/nanohost/openshell-pin/proto/options.proto",
      "checksum": "sha256:10c8a99b505047f759951285fdae6068afd267ef672d00a65385a91ee8d027ee",
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    }
  ],
  "consumedRpcRoots": [
    "CreateSandbox",
    "GetSandbox",
    "ListSandboxes",
    "DeleteSandbox",
    "ForwardTcp",
    "ExecSandbox",
    "ExecSandboxInteractive",
    "ConnectSupervisor",
    "RelayStream",
    "CreateSshSession",
    "RevokeSshSession"
  ],
  "artifacts": [
    {
      "kind": "gateway-executable",
      "name": "openshell-gateway-aarch64-unknown-linux-gnu.tar.gz",
      "representation": "release-archive",
      "platform": "linux/arm64",
      "publisherChecksumFile": "openshell-gateway-checksums-sha256.txt",
      "checksum": "sha256:3a5d3092ae34356beb0ff2a920f9a87af4233c7a1086a53cd9429d48358f5c09",
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "kind": "gateway-executable",
      "name": "openshell-gateway",
      "representation": "extracted-executable",
      "platform": "linux/arm64",
      "derivedFrom": "openshell-gateway-aarch64-unknown-linux-gnu.tar.gz",
      "checksum": "sha256:35c1e1be9c8766de2bfd457e54918d6b2019c16da815ec4c45ce9ebb45aaa571",
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "kind": "redistribution-license",
      "name": "LICENSE",
      "representation": "source-file",
      "sourcePath": "LICENSE",
      "bundlePath": "licenses/openshell-LICENSE",
      "checksum": "sha256:b967d1c87b93b7d61ebcf4f8737e6ad79e5433e743e49dff395a36fb3c327047",
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "kind": "redistribution-notices",
      "name": "THIRD-PARTY-NOTICES",
      "representation": "source-file",
      "sourcePath": "THIRD-PARTY-NOTICES",
      "bundlePath": "licenses/openshell-THIRD-PARTY-NOTICES",
      "checksum": "sha256:8c35aead093cbdfb3e11345d88cf2cb179f86391e859e4a7bc11539a0cc601f8",
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "kind": "supervisor-image",
      "name": "ghcr.io/nvidia/openshell/supervisor:0.0.99@sha256:ea3632b6e9528e2309103af5b6949606fcdc83ca1f69e8db81482a25bea84bb6",
      "representation": "published-multi-platform-oci-index",
      "checksum": "sha256:ea3632b6e9528e2309103af5b6949606fcdc83ca1f69e8db81482a25bea84bb6",
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "kind": "supervisor-image",
      "name": "ghcr.io/nvidia/openshell/supervisor:0.0.99@sha256:4adea8392a81ef34b3cc3284e693ac3cc6c13362fad84a492d95b53b3eb403b9",
      "representation": "tier-2-explicit-platform-oci-image",
      "runtimeResolutionTier": 2,
      "platform": "linux/amd64",
      "parentIndex": "sha256:ea3632b6e9528e2309103af5b6949606fcdc83ca1f69e8db81482a25bea84bb6",
      "checksum": "sha256:4adea8392a81ef34b3cc3284e693ac3cc6c13362fad84a492d95b53b3eb403b9",
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "kind": "supervisor-image",
      "name": "ghcr.io/nvidia/openshell/supervisor:0.0.99@sha256:b548fd939331d830cd9197f20fca9a5d95383c5e67f64929d632a37403115f38",
      "representation": "tier-2-explicit-platform-oci-image",
      "runtimeResolutionTier": 2,
      "platform": "linux/arm64",
      "parentIndex": "sha256:ea3632b6e9528e2309103af5b6949606fcdc83ca1f69e8db81482a25bea84bb6",
      "checksum": "sha256:b548fd939331d830cd9197f20fca9a5d95383c5e67f64929d632a37403115f38",
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "kind": "cli",
      "name": "openshell-aarch64-unknown-linux-musl.tar.gz",
      "representation": "release-archive",
      "publisherChecksumFile": "openshell-checksums-sha256.txt",
      "checksum": "sha256:d00cbf0d8779c01ddea6453ead2ad4db3d89a1f14eb6f0785f7919f42813a279",
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "kind": "cli",
      "name": "openshell",
      "representation": "extracted-executable",
      "derivedFrom": "openshell-aarch64-unknown-linux-musl.tar.gz",
      "checksum": "sha256:9390eac019d2bcabec1cac950ca97982fb3d7bce2560ae00e9c3f237d50b8481",
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    }
  ],
  "observedUpstreamConstants": [
    {
      "name": "pending-claim-timeout",
      "value": {
        "logicalExpirySeconds": 10,
        "backgroundReaperIntervalSeconds": 30
      },
      "sourceLocations": [
        "crates/openshell-server/src/supervisor_session.rs:25#logicalExpirySeconds",
        "crates/openshell-server/src/lib.rs:463#backgroundReaperIntervalSeconds"
      ],
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "name": "forward-chunk-size",
      "value": {
        "bytes": 65536
      },
      "sourceLocations": [
        "crates/openshell-server/src/grpc/sandbox.rs:62,1418-1426#bytes"
      ],
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "name": "relay-chunk-size",
      "value": {
        "bytes": 16384
      },
      "sourceLocations": [
        "crates/openshell-server/src/supervisor_session.rs:461-474,574-587#bytes",
        "crates/openshell-supervisor-process/src/supervisor_session.rs:213-216,602-615#bytes"
      ],
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "name": "gateway-pairing-buffer-size",
      "value": {
        "bytes": 65536
      },
      "sourceLocations": [
        "crates/openshell-server/src/supervisor_session.rs:376-388#bytes"
      ],
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "name": "gateway-adaptive-http2-window",
      "value": true,
      "sourceLocations": [
        "crates/openshell-server/src/multiplex.rs:305-319"
      ],
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "name": "client-adaptive-http2-window",
      "value": {
        "sdk": true,
        "supervisorCore": true,
        "cliPlaintext": true,
        "cliEdgeTunnel": true,
        "cliVerifiedTls": true,
        "cliInsecureTls": false
      },
      "sourceLocations": [
        "crates/openshell-sdk/src/transport.rs:27-40,91-143",
        "crates/openshell-core/src/grpc_client.rs:134-145",
        "crates/openshell-cli/src/tls.rs:343-399"
      ],
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "name": "per-rpc-authorization-annotations",
      "value": {
        "present": true,
        "forwardTcpAuthMode": "bearer",
        "forwardTcpScope": "sandbox:write",
        "forwardTcpWorkspaceRole": "user"
      },
      "sourceLocations": [
        "proto/options.proto:10-29",
        "proto/openshell.proto:174-181"
      ],
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "name": "forward-target-authorization-secret-marking",
      "value": true,
      "sourceLocations": [
        "proto/options.proto:31-35",
        "proto/openshell.proto:1200-1214"
      ],
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    },
    {
      "name": "exec-sandbox-interactive-implementation-closure",
      "value": {
        "rpc": "ExecSandboxInteractive",
        "shape": "bidirectional-streaming",
        "requestType": "ExecSandboxInput",
        "responseType": "ExecSandboxEvent",
        "authorization": {
          "authMode": "bearer",
          "scope": "sandbox:write",
          "workspaceRole": "user"
        },
        "handler": {
          "extractsPrincipal": true,
          "authorizesNamedSandbox": true,
          "requiresReadySandbox": true,
          "relayWaitSeconds": 15
        },
        "maxDecodedInboundBytes": 1048576,
        "relayTarget": "open_relay(Target::Ssh)",
        "proxy": {
          "bind": "127.0.0.1:0",
          "acceptedConnections": 1
        },
        "internalServerKey": "unchecked",
        "sshAuthentication": "authenticate_none(\"sandbox\")",
        "supervisorTarget": "sandbox SSH Unix socket",
        "supervisorPeerPid": "checked when available",
        "eventMapping": {
          "data": "stdout",
          "extendedData": "stderr",
          "exitStatus": "exit"
        },
        "gatewayHttp2KeepaliveSeconds": 20,
        "gatewayHttp2KeepaliveTimeoutSeconds": 10,
        "execKeepaliveSeconds": 15,
        "execKeepaliveMissLimit": 4,
        "postExitCloseTimeoutMilliseconds": 500,
        "requestTimeoutZero": "disabled",
        "requestTimeoutExitCode": 124,
        "inputClose": "SSH EOF and close removes the channel before later ExitStatus and Close",
        "observedPrematureEof": "Exit 124 at 300 seconds",
        "responseDrop": "no definite remote kill proof",
        "missingExit": "Unavailable",
        "semanticUses": [
          {
            "name": "single-file helper",
            "scope": "reference.import and file.export",
            "requestCompletion": "declared length without request EOF",
            "response": "retain through one zero Exit and clean completion"
          }
        ]
      },
      "sourceLocations": [
        "proto/openshell.proto:183-192",
        "crates/openshell-server/src/grpc/sandbox.rs:1479-1549,1746-1773,1885-2148",
        "crates/openshell-server/src/multiplex.rs:195-201,268-273,305-315",
        "crates/openshell-server/src/supervisor_session.rs:237-255",
        "crates/openshell-supervisor-process/src/supervisor_session.rs:689-710"
      ],
      "tag": "v0.0.99",
      "commit": "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032"
    }
  ]
}
```

## Exact Consumed RPC Root Set

The exact consumed root set contains eleven machine-resolvable RPCs: `CreateSandbox`, `GetSandbox`, `ListSandboxes`, `DeleteSandbox`, `ForwardTcp`, `ExecSandbox`, `ExecSandboxInteractive`, `ConnectSupervisor`, `RelayStream`, `CreateSshSession`, and `RevokeSshSession`. `ExecSandbox` owns only the unary worker bootstrap/response monitor inside `bridge.open`; `ExecSandboxInteractive` owns only the fixed single-file helper for `reference.import` and `file.export`. Their existing transitive closure adds no root.

## `ExecSandboxInteractive` Stock Implementation Closure

The bidirectional `ExecSandboxInteractive` RPC requires bearer authentication with `sandbox:write` scope and the user workspace role. Its handler extracts the authenticated principal, authorizes the named sandbox, requires that sandbox to be Ready, applies the Gateway-wide decoded inbound-message cap of 1,048,576 bytes, and then calls `open_relay(Target::Ssh)` with a 15-second relay wait (`NVIDIA/OpenShell@8c7dd148:proto/openshell.proto:183-192`; `NVIDIA/OpenShell@8c7dd148:crates/openshell-server/src/grpc/sandbox.rs:1479-1549`; `NVIDIA/OpenShell@8c7dd148:crates/openshell-server/src/multiplex.rs:195-201,268-273`).

The Gateway creates one single-use ephemeral loopback listener at `127.0.0.1:0`, accepts one internal connection, uses an unchecked internal server key, and calls `authenticate_none("sandbox")`. `Data`, `ExtendedData`, and `ExitStatus` messages map to stdout, stderr, and one final exit event. The Supervisor connects `open_relay(Target::Ssh)` to the sandbox SSH Unix socket and checks the peer PID when available (`NVIDIA/OpenShell@8c7dd148:crates/openshell-server/src/grpc/sandbox.rs:1966-2148`; `NVIDIA/OpenShell@8c7dd148:crates/openshell-server/src/supervisor_session.rs:237-255`; `NVIDIA/OpenShell@8c7dd148:crates/openshell-supervisor-process/src/supervisor_session.rs:689-710`).

Gateway HTTP/2 keepalive uses a 20-second interval and 10-second timeout; exec SSH keepalive uses a 15-second interval with four missed responses, and the post-exit close wait is capped at 500 milliseconds. Closing the Interactive request stream sends SSH EOF and close, removes the channel before later `ExitStatus` and `Close`, and was observed as exit 124 at 300 seconds. The single-file helper therefore completes from declared length while NanoHost retains the sender through exact Exit and clean response settlement. A nonzero request timeout emits exit 124, response drop supplies no definite remote-kill proof, and a channel close with missing exit status is `Unavailable` (`NVIDIA/OpenShell@8c7dd148:crates/openshell-server/src/multiplex.rs:305-315`; `NVIDIA/OpenShell@8c7dd148:crates/openshell-server/src/grpc/sandbox.rs:1746-1773,1885-1963,2033-2109`).

The worker bootstrap/monitor uses unary-request/server-streaming-response `ExecSandbox` with `timeout_seconds=0`, exact 88-byte two-token stdin, and request EOF before execution within the pinned whole-message 1,048,576-byte cap. NanoHost retains the response as the epoch-local attempt monitor concurrently with one `ForwardTcp` stream on the same authenticated Gateway client and current sandbox. Response drop proves no remote kill; success requires the accepted Exit and clean response completion, while a missing Exit remains `Unavailable` at the stock RPC boundary.

## Client Selection

At `v0.0.99`, `OpenShellClient` exposes typed `create_sandbox`, `get_sandbox`, `list_sandboxes(ListOptions)`, and `delete_sandbox` methods, while `raw_grpc` and `raw_grpc_fresh` expose the authenticated generated client needed for `ForwardTcp`, `ExecSandbox`, and `ExecSandboxInteractive` (`NVIDIA/OpenShell@8c7dd148:crates/openshell-sdk/src/client.rs:84-115,154-218`; `NVIDIA/OpenShell@8c7dd148:crates/openshell-sdk/src/raw.rs:21-38`).

The disposable compile probe type-checked those lifecycle calls, `raw_grpc().forward_tcp(...)`, `TcpForwardFrame`, and `raw_grpc().exec_sandbox_interactive(...)` over a fake `ReceiverStream<ExecSandboxInput>`. Its resolved graph contained `openshell-sdk` and `openshell-core` but no OpenShell server, driver, Gateway-interceptor, Supervisor, CLI, TUI, or prover crate; the retained probe evidence is at `apps/nanohost/openshell-pin/evidence/compile-probe`.

That observed surface satisfies the selection condition in `docs/specs/20260802-nanohost_runtime_and_transport.md:338-344`, so the determined client path is the upstream Rust SDK pinned to this commit and its lockfile; generated Tonic clients from the vendored protobuf definitions are not selected.

### Delegated Annex Weighing

The annex conflict at `docs/specs/20260802-nanohost_runtime_and_transport.md`, `### Pin Manifest Location` under `## Stock Realization Annex` ("Both client paths preserve the consumed interface definitions...") is resolved: both client paths preserve the consumed interface definitions inside this manifest with an individual checksum for each one, and the remaining difference is build enforcement, which MAY be weighed in this record.

The observed build-enforcement difference is that on the generated-client path these vendored definitions would be code-generation inputs, so upstream interface drift would break the NanoHost build; on the selected SDK path the definitions remain individually checksummed re-pin evidence that no NanoHost build consumes, while the pinned SDK source and lockfile enforce the client boundary at build time instead. That difference does not change the evidence-determined SDK selection recorded above: the A1 compile probe and selection condition at `docs/specs/20260802-nanohost_runtime_and_transport.md:338-344` already establish the upstream Rust SDK as the client path.

## Consumed-Surface Dispositions From `v0.0.80` To `v0.0.99`

| Consumed surface | Disposition | Evidence and consequence |
| --- | --- | --- |
| Protocol | compatible | The consumed create, get, list, and delete RPCs remain unary, and `ForwardTcp`, `ExecSandboxInteractive`, `ConnectSupervisor`, and `RelayStream` retain their bidirectional-streaming shapes; the nine new identity and workspace RPCs are additive (`NVIDIA/OpenShell@8c7dd148:proto/openshell.proto:21-192,427-455,583-648`). |
| CLI | compatible | NanoHost consumes the CLI only for installation-time version inspection and authorized diagnostics, and the A1 executable self-reported `0.0.99`; command and presentation changes between the tags do not enter the normal lifecycle settlement path, which remains excluded by `docs/specs/20260802-nanohost_runtime_and_transport.md:346-352`. |
| SDK | adapted | The Rust SDK is new in `v0.0.99`; NanoHost selects its typed lifecycle methods and authenticated raw-client escape hatch, passes `ListOptions` to list operations, and links no server-side crate (`NVIDIA/OpenShell@8c7dd148:crates/openshell-sdk/src/client.rs:84-115,154-218`; `NVIDIA/OpenShell@8c7dd148:crates/openshell-sdk/src/raw.rs:21-38`). |
| Protobuf | adapted | The four consumed definitions add workspace metadata, workspace resources, middleware configuration, authorization options, and secret markings without removing, renaming, or retyping an existing consumed field, enum value, or RPC; NanoHost preserves the exact four definitions and treats the new authorization metadata as operative rather than relying only on protobuf wire compatibility (`NVIDIA/OpenShell@8c7dd148:proto/datamodel.proto:15-87`; `NVIDIA/OpenShell@8c7dd148:proto/options.proto:10-35`; `NVIDIA/OpenShell@8c7dd148:proto/sandbox.proto:18-94,344-389`; `NVIDIA/OpenShell@8c7dd148:proto/openshell.proto:21-648,900-1011,1200-1222`). |
| Gateway | adapted | The actual Gateway changes on the consumed path are principal extraction and workspace authorization for create, get, list, delete, and `ForwardTcp`; workspace-scoped persistence and lookup; annotations and label selectors; platform-admin gating for all-workspace listing; Docker-aware process-identity normalization; and a 19-character DNS-1123 sandbox-name boundary. NanoHost must use authenticated workspace-scoped requests and preserve cross-workspace non-disclosure. Because the accepted NanoHost backend is a dedicated `dockerd`, it takes the Docker branch: the Gateway no longer injects `sandbox:sandbox` when process identity is omitted and instead defers to the image's OCI `USER`. The Supervisor accepts that OCI fallback only when the identity exists and is non-root, rejecting `root`, UID 0, and primary GID 0 and failing the sandbox closed when neither policy nor image supplies an identity. This behavior change is an imaging and policy obligation, not a containment weakening: every NanoHost sandbox image must declare a non-root OCI `USER`, or NanoHost must set process identity explicitly in the policy; a bare base image without such a `USER` is not a usable sandbox image at this pin. WP-1 real-use evidence must assert the observed uid inside a created sandbox, and the A1 observation did: `uid=998`, non-root. At `v0.0.80`, a caller-supplied name could be any 253-byte string; at `v0.0.99`, an empty name still selects a server-generated, truncated fallback, but every supplied name must be at most 19 characters and contain only lowercase ASCII alphanumerics and non-leading, non-trailing, non-consecutive hyphens. The retired `openShellSandboxName` scheme cannot create any sandbox at the pin: it builds `oks-<namespace>-worker-<up to 10 session-id characters>-<12 hex characters>`, which is at least 39 characters even with an empty session-id contribution and the shortest generated namespace, and it admits `_`, `.`, and uppercase in the session-id contribution as three additional rejection paths. The 19-character DNS-1123 name rule makes the retired OpenKit naming scheme unportable at this pin, so NanoHost must generate a compliant opaque name instead of encoding lineage in the name; the mechanism for carrying deployment, worker, and session lineage is not selected by this manifest and is left to the accepted owner that will make that call. Loopback target validation, relay pairing and byte bridging, the SSH-session token guard, and the 3-per-token and 20-per-sandbox slot ceilings are unchanged and are not re-pin differences (`NVIDIA/OpenShell@8c7dd148:crates/openshell-server/src/grpc/sandbox.rs:144-149,213-301,348-435,711-757,1150-1207,1228-1375`; `NVIDIA/OpenShell@8c7dd148:crates/openshell-server/src/grpc/validation.rs:35-45,128-177`; `NVIDIA/OpenShell@8c7dd148:crates/openshell-policy/src/lib.rs:1093-1101`; `NVIDIA/OpenShell@8c7dd148:crates/openshell-supervisor-process/src/identity.rs:223-266`; `NVIDIA/OpenShell@8c7dd148:crates/openshell-server/src/grpc/mod.rs:123-128`; `apps/nanocore/src/runtime/worker-governance-backend.ts:2872-2877,2898-2912`; comparison: `NVIDIA/OpenShell@709aa0fe:crates/openshell-server/src/grpc/sandbox.rs:61-279,479-518,915-1147`; `NVIDIA/OpenShell@709aa0fe:crates/openshell-policy/src/lib.rs:1075-1083`; `NVIDIA/OpenShell@709aa0fe:crates/openshell-server/src/grpc/validation.rs:93-103`; `NVIDIA/OpenShell@709aa0fe:crates/openshell-server/src/grpc/mod.rs:102-103`). |
| Supervisor | adapted | The resolved `v0.0.99` commit is `8c7dd148`, `perf(net): set TCP_NODELAY on latency-sensitive TCP hops (#2220)`. The stock Supervisor retains `RelayOpen`/`RelayStream`, raw `RelayFrame` bytes, and loopback-only TCP targeting, but `connect_tcp_target` now applies `TCP_NODELAY` to the Integration-loopback dial. The middleware configuration added elsewhere in `v0.0.99` has no code path in the Supervisor session implementation and therefore does not change the consumed transport shape (`NVIDIA/OpenShell@8c7dd148:crates/openshell-supervisor-process/src/supervisor_session.rs:1-1123`). WP-1 saturation, added-latency, interrupt-p99, and heartbeat-margin results therefore measure different small-write behavior from every prior `v0.0.80` observation and must name `TCP_NODELAY` as a measurement condition (`NVIDIA/OpenShell@8c7dd148:crates/openshell-supervisor-process/src/supervisor_session.rs:690-764`; comparison: `NVIDIA/OpenShell@709aa0fe:crates/openshell-supervisor-process/src/supervisor_session.rs:576-641`). `v0.0.99` also adds expected-shutdown-close handling on the Supervisor session: `SessionStreamMessage::ExpectedShutdownClose`, `expected_transport_close_during_shutdown`, and the imported `openshell_core::transport_errors::is_expected_transport_close_status` treat a stream close observed while the supervisor's `terminating` `AtomicBool` is set as an expected local-shutdown close rather than a transport failure at both the session control stream and the relay-bridge `relay_stream` call and its inbound loop, and `run_session_loop` returns without reconnecting once `run_single_session` reports that expected close (`NVIDIA/OpenShell@8c7dd148:crates/openshell-supervisor-process/src/supervisor_session.rs:37,233-271,306-324,409-417,580-591,641-652`). Consequently a closed relay can no longer be treated as failure unconditionally: NanoHost must distinguish an expected local-shutdown close while the supervisor's `terminating` flag is set from a transport failure, and this distinction lands on definite predecessor-closure and epoch-invalidation decisions that later packages must make; it is recorded here as a consequence and obligation, not implemented by this manifest. |
| Provider | adapted | Provider requests gained workspace fields, profiles gained annotations, source, and scope, and refresh gained AWS STS and additional-output fields; provider setup therefore uses the authenticated raw SDK surface with the current workspace and pinned `v0.0.99` messages (`NVIDIA/OpenShell@8c7dd148:proto/openshell.proto:1328-1396,1474-1593,1613-1714`; `NVIDIA/OpenShell@8c7dd148:crates/openshell-sdk/src/raw.rs:4-30`). |
| Policy | adapted | Policy and configuration messages gained workspace, annotations, middleware, validation-failure, and provenance fields; NanoHost must send policy setup through the authenticated raw SDK surface and preserve the pinned message semantics rather than project a `v0.0.80` shape (`NVIDIA/OpenShell@8c7dd148:proto/sandbox.proto:18-94,344-389`; `NVIDIA/OpenShell@8c7dd148:proto/openshell.proto:1768-1785,1833-1914,2405-2461`). |
| Authentication | adapted | `v0.0.99` adds descriptor-backed per-RPC authorization and secret-field options; lifecycle and `ForwardTcp` require bearer authorization with their declared scopes and workspace role, and `TcpForwardInit.authorization_token` is secret-marked in addition to the separate SSH-token validation described below (`NVIDIA/OpenShell@8c7dd148:proto/options.proto:10-35`; `NVIDIA/OpenShell@8c7dd148:proto/openshell.proto:45-181,1200-1214`). `v0.0.99` also secret-marks every token on the consumed SSH-bridge path — `CreateSshSessionResponse.token` (the same `ForwardTcp` target-authorization material described above), `RevokeSshSessionRequest.token`, and the persisted `SshSession.token` — plus the consumed provider-refresh credential material in `StoredProviderCredentialRefreshState.material` and `ConfigureProviderRefreshRequest.material`, and the consumed `openshell.datamodel.v1.Provider.credentials` map carried by `CreateProviderRequest`, `ProviderResponse`, and `ListProvidersResponse` (`NVIDIA/OpenShell@8c7dd148:proto/openshell.proto:1026-1034,1135-1138,1244-1260,1528-1550,1563-1572`; `NVIDIA/OpenShell@8c7dd148:proto/datamodel.proto:78`). NanoHost must treat every one of these fields as secret: it must not appear in logs, audit records, error messages, epoch-invalidation reports, or change records in the clear; implementing that redaction is a later-package obligation for WP-3a and WP-4 and is not discharged by this manifest. |
| Image | adapted | The CLI, Gateway executable, and Supervisor payload were replaced as one `v0.0.99` release set, and the Supervisor default changed from floating `ghcr.io/nvidia/openshell/supervisor:latest` to a tag resolved at build time from `OPENSHELL_IMAGE_TAG`, `IMAGE_TAG`, or the package version, with `dev` only as the development fallback. The published Supervisor identity is multi-platform index `sha256:ea3632b6e9528e2309103af5b6949606fcdc83ca1f69e8db81482a25bea84bb6`; the declared deployment fixes the private Gateway's existing `supervisor_image` field to its exact compile-target child manifest, `sha256:4adea8392a81ef34b3cc3284e693ac3cc6c13362fad84a492d95b53b3eb403b9` for `linux/amd64` or `sha256:b548fd939331d830cd9197f20fca9a5d95383c5e67f64929d632a37403115f38` for `linux/arm64`. The driver extracts and caches its static-musl `/openshell-sandbox` through the existing upstream path and never consumes the lower-priority Tier-3 GNU sibling (`NVIDIA/OpenShell@8c7dd148:crates/openshell-core/src/config.rs:76-109`; comparison: `NVIDIA/OpenShell@709aa0fe:crates/openshell-core/src/config.rs:40-41`; `NVIDIA/OpenShell@8c7dd148:crates/openshell-driver-docker/src/lib.rs:3111-3188,3204-3263`). |
| Lifecycle | adapted | The new SDK supplies typed lifecycle methods, workspace-scoped variants inject the selected workspace, list requires `ListOptions`, and delete acknowledgement can precede terminal deletion; NanoHost must use the workspace-scoped path and observe terminal state rather than treating the delete response as settlement (`NVIDIA/OpenShell@8c7dd148:crates/openshell-sdk/src/client.rs:180-218,507-587`). |

No `v0.0.80` to `v0.0.99` consumed-surface difference blocks the pin for a conforming new implementation, but the retired OpenKit sandbox naming scheme is a concrete consumed path that cannot be ported unchanged, so the `Gateway` disposition remains `adapted`; this disposition neither satisfies nor waives the separate real-use realization gate in `docs/specs/20260802-nanohost_runtime_and_transport.md:1165-1171`.

## Standing `ForwardTcp` Target-Authorization Property

This is realization evidence about the stock Gateway, not a `v0.0.80` to `v0.0.99` difference. Both tags reject an empty `TcpForwardInit.authorization_token`, load the token as an `SshSession`, check sandbox binding, revocation, and expiry, and apply identical limits of three connections per token and twenty per sandbox; the only textual change inside the slot-acquisition function is shortening the `HashMap` import path (`NVIDIA/OpenShell@8c7dd148:proto/openshell.proto:1200-1214`; `NVIDIA/OpenShell@8c7dd148:crates/openshell-server/src/grpc/sandbox.rs:1228-1317`; comparison: `NVIDIA/OpenShell@709aa0fe:crates/openshell-server/src/grpc/sandbox.rs:997-1097`).

Consequently, establishing the fixed Integration loopback TCP bridge requires `CreateSshSession` target authorization material even though the target is TCP, and the bridge consumes one of the token's three connection slots and one of the sandbox's twenty connection slots until its guard is dropped (`NVIDIA/OpenShell@8c7dd148:crates/openshell-server/src/grpc/sandbox.rs:1210-1225,1282-1314,1560-1638`).

Revocation and expiry are checked when the connection guard is acquired, not continuously by the byte-bridge loops; revocation only marks the stored session and the reaper only deletes revoked or expired session records, so source inspection shows that revoking or expiring a token does not itself close an already-live bridge, while any later bridge establishment with that token fails and requires fresh target authorization material (`NVIDIA/OpenShell@8c7dd148:crates/openshell-server/src/grpc/sandbox.rs:1256-1279,1377-1435,1641-1707`; `NVIDIA/OpenShell@8c7dd148:crates/openshell-server/src/ssh_sessions.rs:22-69`).

The unchanged guard does not prove that the retired OpenKit path ever opened a loopback-TCP `ForwardTcp` under such a token: that path reached sandboxes over SSH and an operator-managed Gateway forward. WP-1 must therefore treat this mechanism as unproved for the accepted design even though the stock code is unchanged.

## Supervisor Resolution And Image Identity

The Docker driver resolves the Supervisor binary through five ordered tiers: explicit `supervisor_bin`, explicit `supervisor_image`, a sibling `openshell-sandbox` beside the Gateway, a local Cargo target binary, then the release-matched default OCI image (`NVIDIA/OpenShell@8c7dd148:crates/openshell-driver-docker/src/lib.rs:3105-3163`). NanoHost preserves the publisher's exact index `sha256:ea3632b6e9528e2309103af5b6949606fcdc83ca1f69e8db81482a25bea84bb6` as release evidence but fixes the private Gateway's `supervisor_image` to the exact child for its compile target: `ghcr.io/nvidia/openshell/supervisor:0.0.99@sha256:4adea8392a81ef34b3cc3284e693ac3cc6c13362fad84a492d95b53b3eb403b9` on `linux/amd64`, or `ghcr.io/nvidia/openshell/supervisor:0.0.99@sha256:b548fd939331d830cd9197f20fca9a5d95383c5e67f64929d632a37403115f38` on `linux/arm64`, so Tier 2 wins before sibling lookup and the network-free Image Store imports the same resolvable manifest identity. The driver uses its existing image extraction and Docker-inspection-ID cache path for the image's static-musl `/openshell-sandbox`; NanoHost does not consume the Tier-3 GNU sibling or any later tier (`NVIDIA/OpenShell@8c7dd148:crates/openshell-driver-docker/src/lib.rs:3111-3188,3204-3263`). An unsupported compile target or missing, changed, unresolvable, or unextractable exact image keeps the epoch non-ready rather than selecting another tier.

## Re-Pin Obligation

Changing this pin requires a fresh complete non-shallow immutable-tag observation, replacement and individual checksumming of every consumed interface definition, one-release resolution of every consumed artifact, explicit compatible, adapted, or blocking disposition for every consumed-surface difference, and re-execution of every NanoHost realization gate before the new pin becomes selectable (`docs/specs/20260522-vendor_snapshot_packages.md:88-106`; `docs/specs/20260802-nanohost_runtime_and_transport.md:1189-1197`).
