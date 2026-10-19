import {
  type CommitArtifactFileVersionRequest,
  type CommitArtifactVersionResponse,
  CommitArtifactVersionResponseSchema,
  type ImportWorkspaceArtifactRequest,
  ImportWorkspaceArtifactResponseSchema,
  OPERATION_DEFINITIONS,
  operationHttpPath,
} from '@openkit/app-api-schemas';
import { ProtocolValidationError } from './errors.js';
import type { ClientTransport } from './transport.js';

/** Exact immutable file bytes and verified response metadata; no full-body allocation. */
export interface ArtifactFileDownload {
  readonly body: ReadableStream<Uint8Array>;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly contentDigest: string;
}

/** Streaming Artifact bindings, separate from definition-derived JSON operations. */
export interface ArtifactFileClient {
  /** Streams one exact next version while retaining the same request across uncertain outcomes. */
  commitVersion(
    input: CommitArtifactFileVersionRequest & {
      readonly workspaceId: string;
      readonly artifactId: string;
      readonly threadId: string;
    },
    body: BodyInit
  ): Promise<CommitArtifactVersionResponse>;
  /** Uploads raw bytes with bounded metadata and the caller's retained request identity. */
  import(
    input: ImportWorkspaceArtifactRequest & { readonly workspaceId: string },
    body: BodyInit
  ): Promise<{ artifactId: string; artifactVersion: 1 }>;
  /** Downloads exactly one requested immutable version as a stream. */
  download(input: {
    readonly workspaceId: string;
    readonly artifactId: string;
    readonly artifactVersion: number;
  }): Promise<ArtifactFileDownload>;
  /** Builds a normal browser download URL; browser navigation uses current cookie authentication. */
  browserDownloadUrl(input: {
    readonly workspaceId: string;
    readonly artifactId: string;
    readonly artifactVersion: number;
  }): string;
}

/** Applies the existing transport's credential, request-id and response validation policy. */
export function createArtifactFileClient(transport: ClientTransport): ArtifactFileClient {
  const browserDownloadUrl: ArtifactFileClient['browserDownloadUrl'] = (input) => {
    const metadata = OPERATION_DEFINITIONS['artifact.download'].inputSchema.parse(input);
    const query = new URLSearchParams(
      Object.entries(metadata).map(([key, value]) => [key, String(value)])
    );
    return transport.url(`${operationHttpPath('artifact.download')}?${query}`);
  };
  return {
    browserDownloadUrl,
    commitVersion: (input, body) => {
      const metadata =
        OPERATION_DEFINITIONS['artifact.version-file-commit'].inputSchema.parse(input);
      const { requestId, summary, ...queryMetadata } = metadata;
      const query = new URLSearchParams([
        ...Object.entries(queryMetadata).map(([key, value]) => [key, String(value)]),
        ['summary', JSON.stringify(summary)],
      ]);
      if (new TextEncoder().encode(`?${query}`).byteLength > 8_192)
        throw invalidFileResponse('File metadata is too large.');
      return transport.postStream(
        `${operationHttpPath('artifact.version-file-commit')}?${query}`,
        body,
        { 'content-type': metadata.mediaType, 'x-openkit-request-id': requestId },
        CommitArtifactVersionResponseSchema
      );
    },
    import: (input, body) => {
      const metadata = OPERATION_DEFINITIONS['artifact.import'].inputSchema.parse(input);
      const { requestId, ...queryMetadata } = metadata;
      const query = new URLSearchParams(
        Object.entries(queryMetadata).map(([key, value]) => [key, String(value)])
      );
      if (new TextEncoder().encode(`?${query}`).byteLength > 8_192) {
        throw invalidFileResponse('File metadata is too large.');
      }
      return transport.postStream(
        `${operationHttpPath('artifact.import')}?${query}`,
        body,
        { 'content-type': metadata.mediaType, 'x-openkit-request-id': requestId },
        ImportWorkspaceArtifactResponseSchema
      );
    },
    download: async (input) => {
      const metadata = OPERATION_DEFINITIONS['artifact.download'].inputSchema.parse(input);
      const query = new URLSearchParams(
        Object.entries(metadata).map(([key, value]) => [key, String(value)])
      );
      const response = await transport.getDownload(
        `${operationHttpPath('artifact.download')}?${query}`
      );
      const length = response.headers.get('content-length');
      const digest = response.headers.get('x-openkit-content-digest');
      const mediaType = response.headers.get('content-type');
      if (
        !length ||
        !/^(0|[1-9][0-9]*)$/.test(length) ||
        !Number.isSafeInteger(Number(length)) ||
        !digest ||
        !/^sha256:[a-f0-9]{64}$/.test(digest) ||
        !mediaType ||
        !response.body
      ) {
        await response.body?.cancel();
        throw invalidFileResponse('Artifact download metadata is invalid.');
      }
      return { body: response.body, byteLength: Number(length), mediaType, contentDigest: digest };
    },
  };
}

/** Creates a bounded transport diagnostic without including response content. */
function invalidFileResponse(message: string): ProtocolValidationError {
  return new ProtocolValidationError({ path: [], code: 'invalid_payload', message });
}
