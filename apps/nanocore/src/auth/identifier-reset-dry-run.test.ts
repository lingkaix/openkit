import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isEntityId } from '@openkit/protocol';
import { afterEach, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { operationRequest } from '../test-support/operation-request.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { createOpenKitAccessTokenRecord } from './access-token-store.js';
import { createBetterAuth } from './better-auth.js';

const roots: string[] = [];
const databases: ReturnType<typeof openCoreDb>[] = [];
const baseUrl = 'http://127.0.0.1:3000';
const subjects = ['protected-one', 'protected-two', 'protected-admin'] as const;
afterEach(async () => {
  await closeRetrievalServices();
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

/** Opens an isolated candidate with the real identity, membership and operation owners. */
function deployment(root = mkdtempSync(join(tmpdir(), 'openkit-id-reset-dry-run-'))) {
  if (!roots.includes(root)) roots.push(root);
  const coreDb = openCoreDb(root);
  databases.push(coreDb);
  applyMigrations(coreDb);
  const store = new FsStore({ dataRoot: root });
  const auth = createBetterAuth(coreDb, {
    mode: 'server',
    env: {
      BETTER_AUTH_URL: baseUrl,
      BETTER_AUTH_SECRET: 'isolated-synthetic-reset-test-secret-at-least-32-characters',
    },
  });
  const admission = new WorkspaceMutationAdmission();
  const app = createApp({
    auth,
    coreDb,
    store,
    dataRoot: root,
    mode: 'server',
    workspaceMutationAdmission: admission,
    repositoryWorkspaceDb: (workspaceId) => {
      const db = openWorkspaceDb(root, workspaceId);
      applyScopedMigrations(db);
      return db;
    },
  });
  return { app, auth, coreDb, store, root, admission };
}

/** Uses public authentication with invented fixture identities; no host account is read. */
async function authenticate(
  target: ReturnType<typeof deployment>,
  subject: string,
  register: boolean
) {
  const response = await target.auth.handler(
    new Request(`${baseUrl}/api/auth/${register ? 'sign-up' : 'sign-in'}/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(register ? { name: subject } : {}),
        email: [subject, 'example.invalid'].join('@'),
        password: 'isolated-synthetic-reset-fixture-password',
      }),
    })
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { user: { id: string } };
  expect(isEntityId('usr', body.user.id)).toBe(true);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  expect(cookie.length > 0).toBe(true);
  return { id: body.user.id, cookie };
}

/** Proves that a current session can create a Workspace and publish exact Artifact bytes. */
async function publish(target: ReturnType<typeof deployment>, cookie: string, label: string) {
  const workspaceResponse = await target.app.request(
    ...operationRequest(
      'workspace.create',
      {},
      {
        headers: { cookie },
        body: JSON.stringify({ name: label, requestId: randomUUID() }),
      }
    )
  );
  expect(workspaceResponse.status).toBe(201);
  const workspace = (await workspaceResponse.json()) as { id: string };
  expect(isEntityId('ws', workspace.id)).toBe(true);
  const content = `Synthetic ${label} evidence`;
  const artifactQuery = new URLSearchParams({
    workspaceId: workspace.id,
    title: label,
    mediaType: 'text/plain',
    byteLength: String(Buffer.byteLength(content)),
    contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  });
  const artifactResponse = await target.app.request(
    `/api/app/operations/artifact.import?${artifactQuery}`,
    {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'text/plain',
        'x-openkit-request-id': randomUUID(),
      },
      body: content,
    }
  );
  expect(artifactResponse.status).toBe(201);
  const artifact = (await artifactResponse.json()) as { artifactId: string };
  expect(isEntityId('ar', artifact.artifactId)).toBe(true);
  return { workspaceId: workspace.id, artifactId: artifact.artifactId, content };
}

it('re-registers the protected synthetic account set on a clean candidate and retains usable source and candidate records', async () => {
  const source = deployment();
  const oldIds: string[] = [];
  const sourceWork = [];
  for (const subject of subjects) {
    const account = await authenticate(source, subject, true);
    oldIds.push(account.id);
    sourceWork.push(await publish(source, account.cookie, `source-${subject}`));
  }
  const oldArtifactBytes = sourceWork.map((work) =>
    JSON.stringify(source.store.getArtifact(work.workspaceId, work.artifactId))
  );
  const candidate = deployment();
  expect(candidate.root).not.toBe(source.root);
  // This variable models selected ingress only; it changes no host or service.
  let selectedIngress = source;
  const verifiedSubjects = new Set<string>();
  let administratorVerified = false;
  let verifiedCandidate: ReturnType<typeof deployment> | null = null;
  const switchCandidate = () => {
    if (
      verifiedSubjects.size !== subjects.length ||
      !administratorVerified ||
      verifiedCandidate === null
    )
      throw new Error('Candidate verification is incomplete.');
    selectedIngress = verifiedCandidate;
  };
  const failedVerification = await candidate.app.request(...operationRequest('token.list', {}, {}));
  expect(failedVerification.status).toBe(401);
  expect(() => switchCandidate()).toThrow('Candidate verification is incomplete.');
  expect(selectedIngress).toBe(source);
  expect(
    sourceWork.map((work) =>
      JSON.stringify(source.store.getArtifact(work.workspaceId, work.artifactId))
    )
  ).toEqual(oldArtifactBytes);
  const newIds: string[] = [];
  const candidateWork = [];
  for (const subject of subjects) {
    const account = await authenticate(candidate, subject, true);
    newIds.push(account.id);
    expect(oldIds.includes(account.id)).toBe(false);
    candidateWork.push(await publish(candidate, account.cookie, `candidate-${subject}`));
  }
  // Account substitution creates new canonical authority; no old record or password hash is copied.
  expect(new Set([...oldIds, ...newIds]).size).toBe(subjects.length * 2);
  for (const table of ['account', 'session'] as const) {
    const rows = candidate.coreDb.sqlite.prepare(`SELECT id FROM ${table}`).all() as Array<{
      id: string;
    }>;
    expect(rows.length).toBeGreaterThanOrEqual(subjects.length);
    expect(rows.every((row) => isEntityId(table === 'account' ? 'acct' : 'auth', row.id))).toBe(
      true
    );
  }
  const adminId = newIds[2]!;
  const admin = createOpenKitAccessTokenRecord(candidate.coreDb, {
    ownerUserId: adminId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  expect(isEntityId('tok', admin.tokenId)).toBe(true);
  // Exercise the existing local Workspace fence; this is not proof of a deployment-wide writer fence.
  for (const work of sourceWork) await source.admission.close(work.workspaceId);
  const oldSession = await authenticate(source, subjects[0], false);
  const fencedQuery = new URLSearchParams({
    workspaceId: sourceWork[0]!.workspaceId,
    title: 'fenced',
    mediaType: 'text/plain',
    byteLength: String(Buffer.byteLength('fenced')),
    contentDigest: `sha256:${createHash('sha256').update('fenced').digest('hex')}`,
  });
  const fenced = await source.app.request(`/api/app/operations/artifact.import?${fencedQuery}`, {
    method: 'POST',
    headers: {
      cookie: oldSession.cookie,
      'content-type': 'text/plain',
      'x-openkit-request-id': randomUUID(),
    },
    body: 'fenced',
  });
  expect(fenced.status).toBe(403);
  expect(
    sourceWork.map((work) =>
      JSON.stringify(source.store.getArtifact(work.workspaceId, work.artifactId))
    )
  ).toEqual(oldArtifactBytes);
  candidate.coreDb.sqlite.close();
  const reopened = deployment(candidate.root);
  for (const [index, subject] of subjects.entries()) {
    const account = await authenticate(reopened, subject, false);
    expect(account.id).toBe(newIds[index]);
    const work = candidateWork[index]!;
    const read = await reopened.app.request(
      ...operationRequest(
        'artifact.read',
        {
          workspaceId: work.workspaceId,
          artifactId: work.artifactId,
        },
        { headers: { cookie: account.cookie } }
      )
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      content: {
        format: 'file',
        mediaType: 'text/plain',
        byteLength: Buffer.byteLength(work.content),
      },
    });
    const downloadQuery = new URLSearchParams({
      workspaceId: work.workspaceId,
      artifactId: work.artifactId,
      artifactVersion: '1',
    });
    const download = await reopened.app.request(
      `/api/app/operations/artifact.download?${downloadQuery}`,
      { headers: { cookie: account.cookie } }
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(work.content);
    verifiedSubjects.add(subject);
    if (index === 2) {
      const adminRead = await reopened.app.request(
        ...operationRequest('token.list', {}, { headers: { cookie: account.cookie } })
      );
      expect(adminRead.status).toBe(200);
      const administratorRead = await reopened.app.request(
        ...operationRequest(
          'administration.cleanup-read',
          {},
          {
            headers: { authorization: `Bearer ${admin.secret}` },
          }
        )
      );
      expect(administratorRead.status).toBe(200);
      administratorVerified = true;
    }
  }
  expect(() => switchCandidate()).toThrow('Candidate verification is incomplete.');
  expect(selectedIngress).toBe(source);
  verifiedCandidate = reopened;
  switchCandidate();
  expect(selectedIngress).toBe(reopened);
  expect(
    sourceWork.map((work) =>
      JSON.stringify(source.store.getArtifact(work.workspaceId, work.artifactId))
    )
  ).toEqual(oldArtifactBytes);
}, 30_000);
