import {
  type AgentEnvironmentCredentialDeclaration,
  AgentEnvironmentCredentialDeclarationSchema,
} from '@openkit/config-schema';
import { isRecord } from '@openkit/protocol';
import {
  credentialHelperComparisonValues,
  type WorkerCredentialHelperCommand,
  WorkerCredentialHelperCommandSchema,
  type WorkerCredentialHelperReply,
} from '@openkit/worker-protocol';
import { runCredentialHelper } from './credential-helper-protocols.js';

const gitCommand = WorkerCredentialHelperCommandSchema.options[0].extend({
  attributes: WorkerCredentialHelperCommandSchema.options[0].shape.attributes.partial(),
});

function unavailable(): never {
  throw new Error('Credential unavailable.');
}

/** Select only on-demand metadata; legacy environment/file projections keep their existing reader. */
export function credentialHelperDeclarations(
  value: unknown
): AgentEnvironmentCredentialDeclaration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) unavailable();
  return value
    .filter(
      (declaration) =>
        isRecord(declaration) &&
        ((declaration.visibility === 'runtime-token' &&
          declaration.consumer === 'credential-helper') ||
          (declaration.visibility === 'external-handle' && declaration.consumer === 'ssh-agent'))
    )
    .map((declaration) => AgentEnvironmentCredentialDeclarationSchema.parse(declaration));
}

/** Complete partial Git selectors only against one current immutable declaration. */
export function selectCredentialHelper(
  declarations: readonly AgentEnvironmentCredentialDeclaration[],
  input: unknown
): { declarationId: string; request: WorkerCredentialHelperCommand } {
  const git = gitCommand.safeParse(input);
  const command = git.success ? git.data : WorkerCredentialHelperCommandSchema.parse(input);
  const candidates = declarations.flatMap((declaration) => {
    if (declaration.visibility === 'external-handle') {
      return command.protocol === 'ssh-agent'
        ? [{ declarationId: declaration.id, request: command }]
        : [];
    }
    if (
      declaration.visibility !== 'runtime-token' ||
      declaration.consumer !== 'credential-helper' ||
      declaration.helper.protocol !== command.protocol
    )
      return [];
    const target = declaration.helper;
    if (target.protocol === 'git' && command.protocol === 'git') {
      if (
        (command.attributes.protocol !== undefined &&
          command.attributes.protocol !== target.scheme) ||
        (command.attributes.host !== undefined && command.attributes.host !== target.host) ||
        (target.path !== undefined &&
          command.attributes.path !== undefined &&
          command.attributes.path !== target.path)
      )
        return [];
      return [
        {
          declarationId: declaration.id,
          request: WorkerCredentialHelperCommandSchema.parse({
            protocol: 'git',
            operation: 'get',
            attributes: {
              protocol: target.scheme,
              host: target.host,
              ...(command.attributes.path !== undefined
                ? { path: command.attributes.path }
                : target.path !== undefined
                  ? { path: target.path }
                  : {}),
            },
          }),
        },
      ];
    }
    if (
      target.protocol === 'docker' &&
      command.protocol === 'docker' &&
      target.serverUrl !== command.target
    )
      return [];
    if (
      target.protocol === 'kubernetes' &&
      command.protocol === 'kubernetes' &&
      target.apiVersion !== command.apiVersion
    )
      return [];
    if (
      target.protocol === 'google' &&
      command.protocol === 'google' &&
      (target.audience !== command.audience || target.subjectTokenType !== command.subjectTokenType)
    )
      return [];
    return [
      {
        declarationId: declaration.id,
        request: WorkerCredentialHelperCommandSchema.parse(command),
      },
    ];
  });
  if (candidates.length !== 1) unavailable();
  return candidates[0]!;
}

/** Validate the actual native output before registering the real process credential strings. */
export async function credentialHelperReplyValues(
  command: WorkerCredentialHelperCommand,
  reply: WorkerCredentialHelperReply
): Promise<readonly string[]> {
  if (command.protocol === 'ssh-agent') {
    if (command.operation === 'identities' ? !('identities' in reply) : !('signature' in reply))
      unavailable();
    return [];
  }
  if (!('credential' in reply)) unavailable();
  const input =
    command.protocol === 'git'
      ? Object.entries(command.attributes)
          .map(([key, value]) => `${key}=${value}\n`)
          .join('') + '\n'
      : command.protocol === 'docker'
        ? command.target + '\n'
        : command.protocol === 'kubernetes'
          ? JSON.stringify({
              kind: 'ExecCredential',
              apiVersion: command.apiVersion,
              spec: { interactive: command.interactive },
            })
          : '';
  const result = await runCredentialHelper(
    { protocol: command.protocol, operation: 'get', input },
    () => reply.credential
  );
  if (result.exitCode !== 0) unavailable();
  return credentialHelperComparisonValues(command, reply);
}
