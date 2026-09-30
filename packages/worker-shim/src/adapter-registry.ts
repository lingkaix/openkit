import type { WorkerLineage } from '@openkit/worker-protocol';
import type { RuntimeCaptureInput } from './runtime-capture.js';

/** One Shim-selected worker LLM route passed unchanged to an adapter. */
export interface WorkerAdapterLlmRoute {
  /** Credential visibility selected by NanoCore. */
  readonly credentialVisibility: 'none' | 'placeholder' | 'environment';
  /** Worker-visible route endpoint. */
  readonly endpoint: {
    /** Endpoint compatibility family. */
    readonly kind: 'openai-compatible' | 'provider-compatible' | 'backend-local';
    /** Optional exact worker-visible base URL. */
    readonly workerBaseUrl?: string | undefined;
    /** Optional resolved upstream authority. */
    readonly upstream?:
      | {
          /** Upstream authority kind. */
          readonly kind: 'nanocore-gateway' | 'backend-local' | 'direct-provider';
          /** Optional non-secret upstream reference. */
          readonly baseUrlRef?: string | undefined;
        }
      | undefined;
  };
  /** Package-local route id. */
  readonly id: string;
  /** Exact resolved model id. */
  readonly model: string;
  /** Effective native model parameters projected by NanoCore, absent on older packages. */
  readonly modelParameters?:
    | {
        readonly contextWindow: number;
        readonly maxOutputTokens: number;
        readonly inputModalities: readonly ('text' | 'image' | 'audio' | 'video' | 'pdf')[];
        readonly reasoning: boolean;
      }
    | undefined;
  /** NanoCore provider instance evidence id. */
  readonly providerInstanceId: string;
}

/** Fixed bounded native provenance declaration supplied by the AEP. */
export interface WorkerAdapterRuntimeProvenance {
  /** Canonical lineage attached to native evidence. */
  readonly lineage: WorkerLineage;
  /** Maximum native streams retained by the capture. */
  readonly maxStreamCount: number;
  /** Maximum aggregate native bytes retained by the capture. */
  readonly maxTotalBytes: number;
  /** Fixed native-origin index output path. */
  readonly nativeOriginIndexPath: '/openkit/session/runtime/native-origin-index.jsonl';
  /** Fixed raw-stream output root. */
  readonly rawStreamsRoot: '/openkit/session/runtime/raw';
  /** Fixed raw-stream manifest output path. */
  readonly streamManifestPath: '/openkit/session/runtime/raw-streams.json';
}

/** Product-safe normalized result returned by an adapter. */
export interface WorkerAdapterResult {
  /** Final assistant candidate, or null when none is trustworthy. */
  readonly assistantText: string | null;
  /** Optional bounded diagnostics for a failed result. */
  readonly diagnostics?: Readonly<Record<string, string>> | undefined;
  /** Normalized terminal status. */
  readonly status: 'completed' | 'failed' | 'interrupted';
  /** Product-safe terminal reason. */
  readonly stopReason: string;
}

/**
 * The adapter's restricted native handle. `ready` carries the exact reference bytes the
 * Harness stores under the AgentSession id; their SHA-256 is the `nativeHandleDigest`.
 */
export type WorkerNativeHandle =
  | { readonly state: 'pending' }
  | { readonly state: 'ready'; readonly reference: Uint8Array }
  | { readonly state: 'unknown' };

/** Fixed loopback endpoints and the two session loopback credentials a resident runtime uses. */
export interface WorkerResidentLoopback {
  /** Capability base URL; the MCP endpoint of server `id` is `${capabilityBaseUrl}/mcp/${id}`. */
  readonly capabilityBaseUrl: string;
  /** Bearer for every capability request of this AgentSession. */
  readonly capabilityCredential: string;
  /** OpenAI-compatible inference base URL. */
  readonly inferenceBaseUrl: string;
  /** Bearer for every inference request of this AgentSession. */
  readonly inferenceCredential: string;
}

/** Input to open one resident native binding for one AgentSession. */
export interface WorkerResidentOpenInput {
  /** Exact Core AgentSession identity. */
  readonly agentSessionId: string;
  /** Disposable AgentSession-private control root below `/openkit`. */
  readonly controlRoot: string;
  /**
   * Safe environment of the resident host: the image allowlist, the fixed scratch root, and the
   * session-static runtime environment. It never contains an upstream route token.
   */
  readonly environment: Readonly<Record<string, string>>;
  /** Loopback endpoints and session credentials. */
  readonly loopback: WorkerResidentLoopback;
  /**
   * Predecessor reference bytes whose SHA-256 the Harness already matched against the carried
   * digest, or null for a new conversation. The adapter validates the native result before work.
   */
  readonly resumeReference: Uint8Array | null;
  /** Retained native data root of the Thread inside the Sandbox volume. */
  readonly stateRoot: string;
}

/** Per-Turn input for one resident binding, resolved from the Turn's own AEP. */
export interface WorkerResidentTurnInput {
  /** The package's unique preferred LLM route selected by the Harness. */
  readonly llmRoute: WorkerAdapterLlmRoute;
  /** Catalog-selected MCP server ids exposed through the fixed capability route. */
  readonly mcpServerIds: readonly string[];
  /** Admission-bound live observation capture. */
  readonly runtimeCapture: RuntimeCaptureInput;
  /** Optional separately owned native provenance declaration. */
  readonly runtimeProvenance?: WorkerAdapterRuntimeProvenance | undefined;
  /** Worker-local Skill trees imported for this Turn. */
  readonly skillTargetPaths: readonly { readonly id: string; readonly targetPath: string }[];
  /** Turn-private directory for native-only outputs, removed after collection. */
  readonly turnDirectory: string;
  /** Exact Core Turn identity. */
  readonly turnId: string;
  /** Private worker Turn input. */
  readonly turnInput: string;
  /** Worker-visible native working directory. */
  readonly workingDirectory: string;
}

/** One Turn accepted by a resident binding. */
export interface WorkerResidentTurn {
  /** Resolves with the normalized result once the native Turn settles; never rejects. */
  readonly settled: Promise<WorkerAdapterResult>;
  /** Requests native interruption and resolves once the Turn has settled. */
  interrupt(): Promise<void>;
}

/** One resident native binding that outlives its Turns. */
export interface WorkerResidentSession {
  /** Settles when the resident host ends on its own; a close does not settle it as a failure. */
  readonly exited: Promise<void>;
  /** Liveness of the resident host process. */
  childState(): 'absent' | 'running' | 'stopping' | 'unknown';
  /** Revokes the native binding and ends a dedicated host; retained native data stays. */
  close(): Promise<void>;
  /** Proves the current restricted native handle without starting work. */
  nativeHandle(): Promise<WorkerNativeHandle>;
  /**
   * Accepts one Turn on the retained conversation and resolves once the runtime accepted it.
   * Rejection guarantees that no native Turn remains live; otherwise cleanup ownership stays with
   * the Harness, which fences admission and keeps the Turn occupied.
   */
  startTurn(input: WorkerResidentTurnInput): Promise<WorkerResidentTurn>;
}

/** Worker-side adapter for one resident native runtime. */
export interface WorkerResidentAdapter {
  /**
   * Opens one resident binding, new or by resume. Rejection guarantees that no native binding or
   * effect remains live; otherwise cleanup ownership must remain with the Harness and admission
   * stays fenced.
   *
   * @param input AgentSession identity, roots, loopback, environment, and resume reference.
   * @returns The live binding.
   */
  openSession(input: WorkerResidentOpenInput): Promise<WorkerResidentSession>;
}

/**
 * Static production adapter registry bundled into every governed worker image. The per-Turn
 * Codex, OpenCode, and Pi adapters were removed with bounded-turn and per-Turn launch; the
 * resident adapters are registered by their own slices of
 * `docs/changes/202609300021100000-agent_communication_redesign/plan.md` (W2 to W5).
 */
export const WORKER_ADAPTERS: Readonly<Record<string, WorkerResidentAdapter>> = {};
