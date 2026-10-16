import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ProposeAdministrationConfigurationRequest } from '@openkit/app-api-schemas';
import { AuthoredAgentConfigSchema } from '@openkit/config-schema';
import { GitFailureExplanationReaderSchema } from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import {
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
} from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import type { FsStore } from '../lib/store.js';
import { findNamedAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { parseJsoncObject } from './jsonc.js';
import type { RuntimeConfigSnapshot } from './runtime-config.js';
import {
  type RuntimeConfigFileService,
  RuntimeConfigFileServiceError,
} from './runtime-config-files.js';

type GitReadProposal = Extract<
  ProposeAdministrationConfigurationRequest,
  { targetFamily: 'agent' }
>;

/** Resolves one registered identity and preserves authored siblings outside the normalized view. */
export function findRegisteredAgentConfiguration(
  files: Pick<RuntimeConfigFileService, 'listFiles' | 'readFile'>,
  agentId: string
) {
  const matches = files
    .listFiles()
    .files.filter((file) => file.kind === 'agent')
    .flatMap((file) => {
      const read = files.readFile(file.id);
      const authored = parseJsoncObject(read.content, file.id);
      const parsed = AuthoredAgentConfigSchema.safeParse(authored);
      return parsed.success &&
        parsed.data.id === agentId &&
        read.file.id === file.id &&
        read.file.kind === 'agent' &&
        read.file.revision
        ? [{ read, authored, value: parsed.data }]
        : [];
    });
  if (matches.length !== 1) refuse();
  return matches[0]!;
}

/** Revalidates the audience, terminal observation and unique retained repository before a repair. */
export function prepareWorkerGitReadCorrection(input: {
  readonly request: GitReadProposal;
  readonly actor: Actor;
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly snapshot: RuntimeConfigSnapshot;
  readonly files: Pick<RuntimeConfigFileService, 'listFiles' | 'readFile'>;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
}) {
  const { request, actor, coreDb, store } = input;
  if (!isCurrentDeploymentAdministrator(coreDb, actor)) refuse();
  if (!input.snapshot.agentManifests.some((agent) => agent.id === request.targetId)) refuse();
  const current = findRegisteredAgentConfiguration(input.files, request.targetId);
  if (current.read.file.revision !== request.expectedRevision) refuse('config_revision_conflict');
  const { workspaceId, threadId, turnId } = request.failure;
  if (
    !isWorkspaceOperationAuthorized(coreDb, actor, workspaceId, {
      mutating: false,
      policyOperation: 'thread.read',
    }) ||
    !isThreadIdVisible(store, workspaceId, threadId, actor.userId, true)
  )
    refuse();
  const turn = store.getTurn(workspaceId, threadId, turnId);
  const explanation = GitFailureExplanationReaderSchema.safeParse(turn.error?.explanation);
  if (
    turn.status !== 'failed' ||
    turn.agentId !== request.targetId ||
    !turn.agentSessionId ||
    !explanation.success
  )
    refuse('configuration_failure_unproved');
  const session = store.getAgentSession(turn.agentSessionId);
  if (
    !session.environmentPackageSnapshotId ||
    session.workspaceId !== workspaceId ||
    session.threadId !== threadId ||
    session.agentId !== request.targetId
  )
    refuse('configuration_failure_unproved');
  const snapshotDb = input.repositoryWorkspaceDb(workspaceId);
  let retained: ReturnType<typeof findNamedAgentEnvironmentPackageSnapshot>;
  try {
    retained = findNamedAgentEnvironmentPackageSnapshot(
      snapshotDb,
      workspaceId,
      session.id,
      session.environmentPackageSnapshotId
    );
  } finally {
    snapshotDb.sqlite.close();
  }
  if (!retained) refuse('configuration_failure_unproved');
  if (
    retained.turnId !== turnId ||
    retained.threadId !== threadId ||
    retained.agentSessionId !== turn.agentSessionId ||
    retained.agentId !== request.targetId
  ) {
    refuse('configuration_failure_unproved');
  }
  const repositories = retained.snapshot.workspace.inputs.filter(
    (entry) => entry.source.kind === 'git'
  );
  // The failure record does not name an input. Selecting one among several would invent causality.
  if (repositories.length !== 1) refuse('configuration_failure_unproved');
  const repository = repositories[0]!;
  const url = new URL(repository.source.url ?? '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/(?:[A-Za-z0-9_~.-]+\/)*[A-Za-z0-9_~.-]+$/.test(url.pathname) ||
    url.pathname.split('/').some((segment) => segment === '.' || segment === '..') ||
    url.href !== repository.source.url
  )
    refuse('configuration_failure_unproved');
  const network = current.value.sandbox?.network ?? [];
  const grants = network.filter((grant) => grant.id === request.changes.networkGrantId);
  if (grants.length !== 1) refuse();
  const grant = grants[0]!;
  if (
    grant.protocol !== 'rest' ||
    !grant.rules ||
    grant.host !== url.hostname ||
    grant.port !== Number(url.port || 443)
  )
    refuse();
  const baseline = [
    { method: 'GET' as const, path: `${url.pathname}/info/refs*` },
    { method: 'POST' as const, path: `${url.pathname}/git-upload-pack` },
  ];
  const isGitReadRule = (rule: { method: string; path: string }) =>
    (rule.method === 'GET' && /\/info\/refs\*?$/.test(rule.path)) ||
    (rule.method === 'POST' && rule.path.endsWith('/git-upload-pack'));
  const unrelated = grant.rules.filter((rule) => !isGitReadRule(rule));
  if (
    !isDeepStrictEqual(
      request.changes.rules.filter((rule) => !isGitReadRule(rule)),
      unrelated
    ) ||
    !isDeepStrictEqual(request.changes.rules.filter(isGitReadRule), baseline) ||
    isDeepStrictEqual(request.changes.rules, grant.rules)
  )
    refuse();
  const rawSandbox = current.authored.sandbox as Record<string, unknown> | undefined;
  const rawNetwork = rawSandbox?.network;
  if (!Array.isArray(rawNetwork)) refuse();
  const authored = {
    ...current.authored,
    sandbox: {
      ...rawSandbox,
      network: rawNetwork.map((value: Record<string, unknown>) =>
        value.id === grant.id ? { ...value, rules: request.changes.rules } : value
      ),
    },
  };
  AuthoredAgentConfigSchema.parse(authored);
  return {
    current,
    content: `${JSON.stringify(authored, null, 2)}\n`,
    changes: request.changes,
    before: { networkGrantId: grant.id, rules: grant.rules },
    after: request.changes,
    facts: {
      responsibleUserId: actor.userId,
      agentId: request.targetId,
      networkGrantId: grant.id,
      host: grant.host,
      port: grant.port,
      protocol: grant.protocol,
      repositoryPath: url.pathname,
      binaries: grant.binaries,
    },
    failureEvidence: {
      agentSessionId: turn.agentSessionId,
      snapshotId: retained.snapshotId,
      snapshotDigest: retained.contentDigest,
      repositoryInputId: repository.id,
      explanationDigest: `sha256:${createHash('sha256').update(JSON.stringify(explanation.data)).digest('hex')}`,
    },
  };
}

/** Fixed safe error: private source and failure decoder details must stay behind this boundary. */
function refuse(code = 'configuration_git_read_scope_rejected'): never {
  throw new RuntimeConfigFileServiceError(
    code,
    'The exact Worker Git-read correction could not be admitted.',
    409
  );
}
