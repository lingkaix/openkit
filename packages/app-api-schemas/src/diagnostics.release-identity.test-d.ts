import type { AppDiagnosticsResponse } from './diagnostics.js';

declare const response: AppDiagnosticsResponse;

/** Server emission keeps both release identity fields readable without an assertion. */
export const releaseTag: string | null = response.build.releaseTag;
/** Server emission keeps the source commit on the same required build object. */
export const sourceCommit: string | null = response.build.sourceCommit;
