import type { WorkerLineage } from '@openkit/worker-protocol';
import { codexAdapter } from './adapters/codex.js';
import { opencodeAdapter } from './adapters/opencode.js';
import { piAdapter } from './adapters/pi.js';

/** One already resolved worker LLM route passed unchanged to an adapter. */
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

/** Resolved runtime-neutral input passed to one worker adapter. */
export interface WorkerAdapterPrepareInput {
  /** Allowlisted environment inherited by the native process. */
  readonly childEnvironment: Record<string, string>;
  /** The package's single already resolved LLM route. */
  readonly llmRoute: WorkerAdapterLlmRoute;
  /** Durable OpenKit session directory. */
  readonly sessionDirectory: string;
  /** Optional separately owned bounded native provenance capture input. */
  readonly runtimeProvenance?: WorkerAdapterRuntimeProvenance | undefined;
  /** Fresh turn-scoped native state root. */
  readonly stateRoot: string;
  /** Private worker turn input. */
  readonly turnInput: string;
  /** Worker-visible native process working directory. */
  readonly workingDirectory: string;
}

/** Native process launch plan returned by an adapter. */
export interface WorkerAdapterLaunchPlan {
  /** Native executable and arguments. */
  readonly argv: string[];
  /** Whether exact stdout must be retained for collection. */
  readonly captureStdout: boolean;
  /** Safe environment visible to the native process. */
  readonly environment: Record<string, string>;
  /** Optional adapter-local cleanup after a failed native lifecycle. */
  readonly invalidate?: (() => Promise<void>) | undefined;
  /** Whether native diagnostics must remain outside ordinary transcript records. */
  readonly suppressFailureDiagnostics?: boolean | undefined;
  /** Optional adapter-local commit after a completed native lifecycle. */
  readonly finalize?: (() => Promise<void>) | undefined;
  /** Optional backpressured adapter-local exact stdout sink. */
  readonly writeStdout?: ((chunk: Uint8Array) => Promise<void>) | undefined;
}

/** Bounded native process result passed to adapter collection. */
export interface WorkerNativeProcessResult {
  /** Native exit code, or null when signaled. */
  readonly exitCode: number | null;
  /** Whether shared supervision interrupted the process. */
  readonly interrupted: boolean;
  /** Native termination signal, or null after a normal exit. */
  readonly signal: NodeJS.Signals | null;
  /** Bounded diagnostic stderr prefix. */
  readonly stderr: string;
  /** Exact bounded stdout bytes requested by the launch plan. */
  readonly stdout: Uint8Array;
}

/** Input passed to one adapter's result collector. */
export interface WorkerAdapterCollectInput {
  /** Launch plan produced by the same adapter. */
  readonly launchPlan: WorkerAdapterLaunchPlan;
  /** Bounded supervised native process result. */
  readonly processResult: WorkerNativeProcessResult;
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

/** Worker-side native adapter with the accepted two-operation contract. */
export interface WorkerAdapter {
  /**
   * Builds one native launch plan from resolved runtime-neutral input.
   *
   * @param input Resolved adapter input.
   * @returns Native launch plan.
   */
  prepare(
    input: WorkerAdapterPrepareInput
  ): WorkerAdapterLaunchPlan | Promise<WorkerAdapterLaunchPlan>;
  /**
   * Normalizes one bounded native process result.
   *
   * @param input Launch plan and bounded native result.
   * @returns Product-safe adapter result.
   */
  collect(input: WorkerAdapterCollectInput): WorkerAdapterResult | Promise<WorkerAdapterResult>;
}

/** Static production adapter registry bundled into every governed worker image. */
export const WORKER_ADAPTERS: Readonly<Record<string, WorkerAdapter>> = {
  codex: codexAdapter,
  opencode: opencodeAdapter,
  pi: piAdapter,
};
