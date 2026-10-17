/** Generic digest comparisons over a confined source range. No value or product proof identity is accepted. */
export interface FileDigestWindowPattern {
  readonly window_bytes: number;
  readonly encoding: 'bytes' | 'base64url-text' | 'base64url-decoded';
  readonly digests: readonly string[];
}
/** Caller bounds tighten the sidecar's fixed byte, match, time and memory limits. */
export interface FileDigestWindowScanInput {
  readonly path: string;
  readonly source_bytes: number;
  readonly start: number;
  readonly end: number;
  readonly patterns: readonly FileDigestWindowPattern[];
  readonly bounds: {
    readonly max_bytes: number;
    readonly max_matches: number;
    readonly timeout_ms: number;
  };
}
/** A complete range proof, never a full-file digest or a product admission decision. */
export interface FileDigestWindowScanResult {
  readonly start: number;
  readonly end: number;
  readonly bytes: number;
  readonly range_digest: string;
  readonly matches: readonly { readonly start: number; readonly end: number }[];
}
/** Strong source scan seam. Resource exhaustion, cancellation and incomplete coverage must reject. */
export type FileDigestWindowScanner = (
  input: FileDigestWindowScanInput
) => Promise<FileDigestWindowScanResult>;
