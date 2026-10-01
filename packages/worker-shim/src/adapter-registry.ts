import type { ReasoningEffort } from '@openkit/protocol';
import type { WorkerLineage } from '@openkit/worker-protocol';
import { codexResidentAdapter } from './adapters/codex.js';
import { deepseekResidentAdapter } from './adapters/deepseek.js';
import { opencodeAdapter } from './adapters/opencode.js';
import { piResidentAdapter } from './adapters/pi.js';
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
  /** Present (including empty) only for a reasoning route; advertisement does not constrain delivery. */
  readonly reasoningEffortLevels?: readonly ReasoningEffort[] | undefined;
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
  /** Optional bounded diagnostics for native delivery and settlement. */
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
  /** Exact admitted logical-model routes fixed for this binding; the adapter must use the preferred llmRoute for this Turn and may select only a route in this set for later Turns. */
  readonly allowedLlmRoutes: readonly WorkerAdapterLlmRoute[];
  /** Recorded preference from this Turn's AEP; absence leaves native selection in place. */
  readonly reasoningEffort?: ReasoningEffort | undefined;
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

/** One accepted native Turn, or an unproved native attempt retained for Harness cleanup. */
export interface WorkerResidentTurn {
  /** Resolves with a normalized result only after native settlement is proved; rejects when settlement cannot be proved, requiring bounded Harness stop confirmation or fencing. */
  readonly settled: Promise<WorkerAdapterResult>;
  /** Requests interruption and resolves only after the addressed native work is proved stopped; rejection or non-resolution does not prove settlement. */
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
  /** Returns accepted native work or an unproved attempt for Harness cleanup; rejects only when the runtime did not accept the Turn and no native Turn work remains live. */
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
 * Codex, OpenCode, and Pi adapters were removed with bounded-turn and per-Turn launch. The
 * resident Codex App Server v2, DeepSeek, OpenCode, and Pi adapters are registered here.
 */
export const WORKER_ADAPTERS: Readonly<Record<string, WorkerResidentAdapter>> = {
  codex: codexResidentAdapter,
  deepseek: deepseekResidentAdapter,
  opencode: opencodeAdapter,
  pi: piResidentAdapter,
};
