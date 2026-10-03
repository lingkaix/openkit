// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GENERATIVE_UI_NATIVE_CATALOG_ID,
  GENERATIVE_UI_PROTOCOL_VERSION,
} from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { createBetterAuth } from '../auth/better-auth.js';
import { ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';

const PRIVATE_TITLE = 'Secret private mapping needle';
const PRIVATE_TEXT = 'Secret private mapping content';
const SHARED_TITLE = 'Shared mapping view';
const SHARED_TEXT = 'Shared mapping content';

/**
 * Builds native createSurface plus updateComponents messages.
 *
 * @param surfaceId Shared surface id.
 * @param components Complete component set.
 * @returns Producer messages.
 */
function nativeMessages(surfaceId: string, components: unknown[]) {
  return [
    {
      version: GENERATIVE_UI_PROTOCOL_VERSION,
      createSurface: {
        surfaceId,
        catalogId: GENERATIVE_UI_NATIVE_CATALOG_ID,
        sendDataModel: false,
      },
    },
    {
      version: GENERATIVE_UI_PROTOCOL_VERSION,
      updateComponents: { surfaceId, components },
    },
  ];
}

/**
 * Builds one item-source publish body bound to a completed assistant message.
 *
 * @param input Thread, turn, source item, and product-visible copy.
 * @returns Publish request body.
 */
function itemPublishBody(input: {
  readonly fallbackText: string;
  readonly itemId: string;
  readonly itemText: string;
  readonly threadId: string;
  readonly title: string;
  readonly turnId: string;
}) {
  return {
    threadId: input.threadId,
    turnId: input.turnId,
    title: input.title,
    fallbackText: input.fallbackText,
    messages: nativeMessages('surface-audience', [
      {
        id: 'root',
        component: 'Column',
        children: ['body', 'refresh'],
      },
      { id: 'body', component: 'Text', text: { path: '/text' } },
      {
        id: 'refresh',
        component: 'Button',
        child: 'refreshLabel',
        action: { event: { name: 'refreshNow' } },
      },
      { id: 'refreshLabel', component: 'Text', text: 'Refresh' },
    ]),
    source: {
      kind: 'item' as const,
      itemId: input.itemId,
      contentDigest: `sha256:${createHash('sha256').update(input.itemText, 'utf8').digest('hex')}`,
    },
    actions: [{ name: 'refreshNow', componentId: 'refresh', kind: 'refresh' as const }],
  };
}

/**
 * Builds the native refresh event admitted by the item-source fixture.
 *
 * @returns Refresh request body.
 */
function refreshEvent() {
  return {
    version: GENERATIVE_UI_PROTOCOL_VERSION,
    action: {
      name: 'refreshNow',
      surfaceId: 'surface-audience',
      sourceComponentId: 'refresh',
      timestamp: '2026-09-16T00:00:00.000Z',
    },
  };
}

describe('Generative UI Thread audience', () => {
  it('keeps admitted reads and publications visible while refusing private source disclosure across owners', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-generative-ui-audience-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Audience team');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    const now = Date.now();
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at) VALUES ('user_other', 'Other', 'other@example.invalid', false, ?, ?, 'human', 'active', NULL)`
      )
      .run(now, now);
    const stamp = '2026-09-16T00:00:00.000Z';
    coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, status, access_level, invitation_id, joined_at, removed_at, revision, created_at, updated_at) VALUES (?, 'user_other', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
      )
      .run(workspace.id, stamp, stamp, stamp);

    const ownPrivateThread = store.createThread(
      workspace.id,
      'Own private audience thread',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: 'user_local' }
    );
    const otherPrivateThread = store.createThread(
      workspace.id,
      'Other private audience thread',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: 'user_other' }
    );
    const sharedThread = store.createThread(
      workspace.id,
      'Shared audience thread',
      undefined,
      'conversation',
      { visibility: 'workspace' }
    );
    const ownPrivateTurn = store.createTurn(
      workspace.id,
      ownPrivateThread.id,
      'Publish own private view',
      { kind: 'user', id: 'user_local' }
    );
    const otherPrivateTurn = store.createTurn(
      workspace.id,
      otherPrivateThread.id,
      'Publish other private view',
      { kind: 'user', id: 'user_other' }
    );
    const sharedTurn = store.createTurn(workspace.id, sharedThread.id, 'Publish shared view', {
      kind: 'user',
      id: 'user_local',
    });
    const ownPrivateSource = store.createItem({
      id: `it_${ownPrivateTurn.id}_source`,
      workspaceId: workspace.id,
      threadId: ownPrivateThread.id,
      turnId: ownPrivateTurn.id,
      type: 'assistant-message',
      status: 'completed',
      text: PRIVATE_TEXT,
      createdAt: ownPrivateTurn.startedAt ?? stamp,
      completedAt: ownPrivateTurn.startedAt ?? stamp,
    });
    const otherPrivateSource = store.createItem({
      id: `it_${otherPrivateTurn.id}_source`,
      workspaceId: workspace.id,
      threadId: otherPrivateThread.id,
      turnId: otherPrivateTurn.id,
      type: 'assistant-message',
      status: 'completed',
      text: PRIVATE_TEXT,
      createdAt: otherPrivateTurn.startedAt ?? stamp,
      completedAt: otherPrivateTurn.startedAt ?? stamp,
    });
    const sharedSource = store.createItem({
      id: `it_${sharedTurn.id}_source`,
      workspaceId: workspace.id,
      threadId: sharedThread.id,
      turnId: sharedTurn.id,
      type: 'assistant-message',
      status: 'completed',
      text: SHARED_TEXT,
      createdAt: sharedTurn.startedAt ?? stamp,
      completedAt: sharedTurn.startedAt ?? stamp,
    });

    const app = createApp({
      auth: createBetterAuth(coreDb),
      coreDb,
      dataRoot,
      mode: 'server',
      store,
    });
    const ownerToken = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: [workspace.id],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const memberToken = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_other',
      scope: 'workspace',
      workspaceIds: [workspace.id],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const adminToken = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const ownerHeaders = { authorization: `Bearer ${ownerToken.secret}` };
    const memberHeaders = { authorization: `Bearer ${memberToken.secret}` };
    const adminHeaders = { authorization: `Bearer ${adminToken.secret}` };

    try {
      const signUp = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'audience-admin@example.invalid',
          name: 'Audience administrator',
          password: 'audience-test-password',
        }),
      });
      expect(signUp.status, await signUp.clone().text()).toBe(200);
      const cookie = signUp.headers.get('set-cookie')?.split(';')[0];
      expect(cookie).toBeTruthy();
      const sessionUser = (await signUp.json()) as { user: { id: string } };
      createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: sessionUser.user.id,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2999-01-01T00:00:00.000Z',
      });
      const sessionHeaders = { cookie: cookie! };
      const administratorCredentials = [
        { name: 'administrator bearer', headers: adminHeaders },
        { name: 'administrator session', headers: sessionHeaders },
      ];
      const ownPublished = await app.request(
        ...operationRequest(
          'generative-ui.publish',
          { workspaceId: workspace.id },
          {
            method: 'POST',
            headers: {
              ...ownerHeaders,
              'content-type': 'application/json',
              'x-openkit-request-id': randomUUID(),
            },
            body: JSON.stringify(
              itemPublishBody({
                fallbackText: PRIVATE_TEXT,
                itemId: ownPrivateSource.id,
                itemText: PRIVATE_TEXT,
                threadId: ownPrivateThread.id,
                title: PRIVATE_TITLE,
                turnId: ownPrivateTurn.id,
              })
            ),
          }
        )
      );
      expect(ownPublished.status, await ownPublished.clone().text()).toBe(201);
      const ownPresentation = (await ownPublished.json()) as { id: string; itemId: string };
      expect(ownPresentation.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );

      const otherPublished = await app.request(
        ...operationRequest(
          'generative-ui.publish',
          { workspaceId: workspace.id },
          {
            method: 'POST',
            headers: {
              ...memberHeaders,
              'content-type': 'application/json',
              'x-openkit-request-id': randomUUID(),
            },
            body: JSON.stringify(
              itemPublishBody({
                fallbackText: PRIVATE_TEXT,
                itemId: otherPrivateSource.id,
                itemText: PRIVATE_TEXT,
                threadId: otherPrivateThread.id,
                title: PRIVATE_TITLE,
                turnId: otherPrivateTurn.id,
              })
            ),
          }
        )
      );
      expect(otherPublished.status, await otherPublished.clone().text()).toBe(201);
      const otherPresentation = (await otherPublished.json()) as { id: string };

      const sharedPublished = await app.request(
        ...operationRequest(
          'generative-ui.publish',
          { workspaceId: workspace.id },
          {
            method: 'POST',
            headers: {
              ...ownerHeaders,
              'content-type': 'application/json',
              'x-openkit-request-id': randomUUID(),
            },
            body: JSON.stringify(
              itemPublishBody({
                fallbackText: SHARED_TEXT,
                itemId: sharedSource.id,
                itemText: SHARED_TEXT,
                threadId: sharedThread.id,
                title: SHARED_TITLE,
                turnId: sharedTurn.id,
              })
            ),
          }
        )
      );
      expect(sharedPublished.status, await sharedPublished.clone().text()).toBe(201);
      const sharedPresentation = (await sharedPublished.json()) as { id: string };

      const ownGet = await app.request(
        ...operationRequest(
          'generative-ui.get',
          { workspaceId: workspace.id, presentationId: ownPresentation.id },
          {
            headers: ownerHeaders,
          }
        )
      );
      expect(ownGet.status).toBe(200);
      await expect(ownGet.json()).resolves.toMatchObject({
        id: ownPresentation.id,
        title: PRIVATE_TITLE,
      });
      const ownResource = await app.request(
        ...operationRequest(
          'generative-ui.resource',
          { workspaceId: workspace.id, presentationId: ownPresentation.id },
          {
            headers: ownerHeaders,
          }
        )
      );
      expect(ownResource.status).toBe(200);
      const ownRefresh = await app.request(
        ...operationRequest(
          'generative-ui.refresh',
          { workspaceId: workspace.id, presentationId: ownPresentation.id },
          {
            method: 'POST',
            headers: { ...ownerHeaders, 'content-type': 'application/json' },
            body: JSON.stringify(refreshEvent()),
          }
        )
      );
      expect(ownRefresh.status, await ownRefresh.clone().text()).toBe(200);

      const sharedByMember = await app.request(
        ...operationRequest(
          'generative-ui.get',
          { workspaceId: workspace.id, presentationId: sharedPresentation.id },
          {
            headers: memberHeaders,
          }
        )
      );
      expect(sharedByMember.status, await sharedByMember.clone().text()).toBe(200);
      await expect(sharedByMember.json()).resolves.toMatchObject({ title: SHARED_TITLE });
      const sharedByAdmin = await app.request(
        ...operationRequest(
          'generative-ui.get',
          { workspaceId: workspace.id, presentationId: sharedPresentation.id },
          {
            headers: adminHeaders,
          }
        )
      );
      expect(sharedByAdmin.status).toBe(200);

      const administratorRead = await app.request(
        ...operationRequest(
          'generative-ui.get',
          { workspaceId: workspace.id, presentationId: otherPresentation.id },
          { headers: adminHeaders }
        )
      );
      expect(administratorRead.status).toBe(200);
      await expect(administratorRead.json()).resolves.toMatchObject({
        id: otherPresentation.id,
        title: PRIVATE_TITLE,
      });

      const administratorSessionRead = await app.request(
        ...operationRequest(
          'generative-ui.get',
          { workspaceId: workspace.id, presentationId: otherPresentation.id },
          { headers: sessionHeaders }
        )
      );
      expect(administratorSessionRead.status).toBe(200);
      await expect(administratorSessionRead.json()).resolves.toMatchObject({
        id: otherPresentation.id,
        title: PRIVATE_TITLE,
      });

      // Read admission permits publication only when the destination retains the source audience.
      for (const credential of administratorCredentials) {
        for (const source of [otherPrivateSource, sharedSource]) {
          const published = await app.request(
            ...operationRequest(
              'generative-ui.publish',
              { workspaceId: workspace.id },
              {
                headers: { ...credential.headers, 'x-openkit-request-id': randomUUID() },
                body: JSON.stringify(
                  itemPublishBody({
                    fallbackText: source.text!,
                    itemId: source.id,
                    itemText: source.text!,
                    threadId: otherPrivateThread.id,
                    title: source === otherPrivateSource ? PRIVATE_TITLE : SHARED_TITLE,
                    turnId: otherPrivateTurn.id,
                  })
                ),
              }
            )
          );
          expect(published.status, `${credential.name}: ${await published.clone().text()}`).toBe(
            201
          );
          await expect(published.json()).resolves.toMatchObject({
            threadId: otherPrivateThread.id,
            source: { itemId: source.id },
          });
        }
      }

      const itemsBeforeDenial = store
        .listAllItems()
        .filter((item) => item.type === 'generative-ui-reference').length;
      let presentationCountBefore = 0;
      const countDb = openWorkspaceDb(dataRoot, workspace.id);
      try {
        applyScopedMigrations(countDb);
        presentationCountBefore = (
          countDb.sqlite.prepare('SELECT COUNT(*) AS n FROM generative_presentations').get() as {
            n: number;
          }
        ).n;
      } finally {
        countDb.sqlite.close();
      }

      const denials = [
        {
          headers: memberHeaders,
          presentationId: ownPresentation.id,
          sourceId: ownPrivateSource.id,
          threadId: ownPrivateThread.id,
          turnId: ownPrivateTurn.id,
        },
        {
          headers: ownerHeaders,
          presentationId: otherPresentation.id,
          sourceId: otherPrivateSource.id,
          threadId: otherPrivateThread.id,
          turnId: otherPrivateTurn.id,
        },
      ];
      for (const denial of denials) {
        for (const suffix of ['', '/resource']) {
          const hidden = await app.request(
            ...operationRequest(
              suffix === '/resource' ? 'generative-ui.resource' : 'generative-ui.get',
              { workspaceId: workspace.id, presentationId: denial.presentationId },
              {
                headers: denial.headers,
              }
            )
          );
          expect(hidden.status).toBe(404);
          const text = await hidden.text();
          expect(text).not.toContain(PRIVATE_TITLE);
          expect(text).not.toContain(PRIVATE_TEXT);
          expect(JSON.parse(text)).toMatchObject({ code: 'not_found' });
        }

        const hiddenRefresh = await app.request(
          ...operationRequest(
            'generative-ui.refresh',
            { workspaceId: workspace.id, presentationId: denial.presentationId },
            {
              method: 'POST',
              headers: { ...denial.headers, 'content-type': 'application/json' },
              body: JSON.stringify(refreshEvent()),
            }
          )
        );
        expect(hiddenRefresh.status).toBe(404);
        const refreshText = await hiddenRefresh.text();
        expect(refreshText).not.toContain(PRIVATE_TITLE);
        expect(refreshText).not.toContain(PRIVATE_TEXT);

        const hiddenAction = await app.request(
          ...operationRequest(
            'generative-ui.action',
            { workspaceId: workspace.id, presentationId: denial.presentationId },
            {
              method: 'POST',
              headers: {
                ...denial.headers,
                'content-type': 'application/json',
                'x-openkit-request-id': randomUUID(),
              },
              body: JSON.stringify({
                version: GENERATIVE_UI_PROTOCOL_VERSION,
                action: {
                  name: 'saveAnnotation',
                  surfaceId: 'surface-audience',
                  sourceComponentId: 'refresh',
                  timestamp: stamp,
                },
              }),
            }
          )
        );
        expect(hiddenAction.status).toBe(404);
        const actionText = await hiddenAction.text();
        expect(actionText).not.toContain(PRIVATE_TITLE);
        expect(actionText).not.toContain(PRIVATE_TEXT);

        const hiddenPublish = await app.request(
          ...operationRequest(
            'generative-ui.publish',
            { workspaceId: workspace.id },
            {
              method: 'POST',
              headers: {
                ...denial.headers,
                'content-type': 'application/json',
                'x-openkit-request-id': randomUUID(),
              },
              body: JSON.stringify(
                itemPublishBody({
                  fallbackText: 'Forged private publication',
                  itemId: denial.sourceId,
                  itemText: PRIVATE_TEXT,
                  threadId: denial.threadId,
                  title: 'Forged private publication',
                  turnId: denial.turnId,
                })
              ),
            }
          )
        );
        expect(hiddenPublish.status).toBe(404);
        const publishText = await hiddenPublish.text();
        expect(publishText).not.toContain(PRIVATE_TITLE);
        expect(publishText).not.toContain(PRIVATE_TEXT);

        const wrongDigestPublish = await app.request(
          ...operationRequest(
            'generative-ui.publish',
            { workspaceId: workspace.id },
            {
              method: 'POST',
              headers: {
                ...denial.headers,
                'content-type': 'application/json',
                'x-openkit-request-id': randomUUID(),
              },
              body: JSON.stringify({
                ...itemPublishBody({
                  fallbackText: 'Forged private publication',
                  itemId: denial.sourceId,
                  itemText: PRIVATE_TEXT,
                  threadId: denial.threadId,
                  title: 'Forged private publication',
                  turnId: denial.turnId,
                }),
                source: {
                  kind: 'item',
                  itemId: denial.sourceId,
                  contentDigest: `sha256:${'0'.repeat(64)}`,
                },
              }),
            }
          )
        );
        expect(wrongDigestPublish.status).toBe(404);
        expect(wrongDigestPublish.status).not.toBe(409);
        const wrongDigestText = await wrongDigestPublish.text();
        expect(wrongDigestText).not.toContain(PRIVATE_TITLE);
        expect(wrongDigestText).not.toContain(PRIVATE_TEXT);
        expect(JSON.parse(wrongDigestText)).toMatchObject({ code: 'not_found' });
      }

      const missingThreadPublish = await app.request(
        ...operationRequest(
          'generative-ui.publish',
          { workspaceId: workspace.id },
          {
            method: 'POST',
            headers: {
              ...memberHeaders,
              'content-type': 'application/json',
              'x-openkit-request-id': randomUUID(),
            },
            body: JSON.stringify(
              itemPublishBody({
                fallbackText: SHARED_TEXT,
                itemId: sharedSource.id,
                itemText: SHARED_TEXT,
                threadId: 'th_missing_audience',
                title: SHARED_TITLE,
                turnId: sharedTurn.id,
              })
            ),
          }
        )
      );
      expect(missingThreadPublish.status).toBe(404);
      await expect(missingThreadPublish.json()).resolves.toMatchObject({ code: 'not_found' });

      const missingTurnPublish = await app.request(
        ...operationRequest(
          'generative-ui.publish',
          { workspaceId: workspace.id },
          {
            method: 'POST',
            headers: {
              ...ownerHeaders,
              'content-type': 'application/json',
              'x-openkit-request-id': randomUUID(),
            },
            body: JSON.stringify(
              itemPublishBody({
                fallbackText: SHARED_TEXT,
                itemId: sharedSource.id,
                itemText: SHARED_TEXT,
                threadId: sharedThread.id,
                title: SHARED_TITLE,
                turnId: 'tu_missing_audience',
              })
            ),
          }
        )
      );
      expect(missingTurnPublish.status).toBe(404);
      const missingTurnText = await missingTurnPublish.text();
      expect(missingTurnText).not.toContain('tu_missing_audience');
      expect(JSON.parse(missingTurnText)).toMatchObject({ code: 'not_found' });

      expect(
        store.listAllItems().filter((item) => item.type === 'generative-ui-reference')
      ).toHaveLength(itemsBeforeDenial);
      const countAfterDb = openWorkspaceDb(dataRoot, workspace.id);
      try {
        expect(
          (
            countAfterDb.sqlite
              .prepare('SELECT COUNT(*) AS n FROM generative_presentations')
              .get() as {
              n: number;
            }
          ).n
        ).toBe(presentationCountBefore);
      } finally {
        countAfterDb.sqlite.close();
      }
      expect(store.getTurn(workspace.id, ownPrivateThread.id, ownPrivateTurn.id).status).toBe(
        'running'
      );
      expect(store.getTurn(workspace.id, otherPrivateThread.id, otherPrivateTurn.id).status).toBe(
        'running'
      );

      for (const credential of [
        { name: 'ordinary owner bearer', headers: ownerHeaders },
        ...administratorCredentials,
      ]) {
        const requestId = randomUUID();
        const sharedItems = store.listThreadItems(workspace.id, sharedThread.id);
        const privateToShared = await app.request(
          ...operationRequest(
            'generative-ui.publish',
            { workspaceId: workspace.id },
            {
              method: 'POST',
              headers: {
                ...credential.headers,
                'content-type': 'application/json',
                'x-openkit-request-id': requestId,
              },
              body: JSON.stringify(
                itemPublishBody({
                  fallbackText: PRIVATE_TEXT,
                  itemId: ownPrivateSource.id,
                  itemText: PRIVATE_TEXT,
                  threadId: sharedThread.id,
                  title: PRIVATE_TITLE,
                  turnId: sharedTurn.id,
                })
              ),
            }
          )
        );
        expect(privateToShared.status).toBe(404);
        expect(JSON.parse(await privateToShared.text())).toMatchObject({ code: 'not_found' });
        expect(store.listThreadItems(workspace.id, sharedThread.id)).toEqual(sharedItems);
        const sharedRefusalDb = openWorkspaceDb(dataRoot, workspace.id);
        try {
          expect(
            sharedRefusalDb.sqlite
              .prepare('SELECT * FROM generative_presentations WHERE request_id = ?')
              .all(requestId)
          ).toEqual([]);
          expect(
            sharedRefusalDb.sqlite
              .prepare('SELECT * FROM idempotency_requests WHERE request_id = ?')
              .all(requestId)
          ).toEqual([]);
        } finally {
          sharedRefusalDb.sqlite.close();
        }
      }

      const otherPrivateToOwn = await app.request(
        ...operationRequest(
          'generative-ui.publish',
          { workspaceId: workspace.id },
          {
            method: 'POST',
            headers: {
              ...ownerHeaders,
              'content-type': 'application/json',
              'x-openkit-request-id': randomUUID(),
            },
            body: JSON.stringify(
              itemPublishBody({
                fallbackText: PRIVATE_TEXT,
                itemId: otherPrivateSource.id,
                itemText: PRIVATE_TEXT,
                threadId: ownPrivateThread.id,
                title: PRIVATE_TITLE,
                turnId: ownPrivateTurn.id,
              })
            ),
          }
        )
      );
      expect(otherPrivateToOwn.status).toBe(404);
      const otherPrivateToOwnText = await otherPrivateToOwn.text();
      expect(otherPrivateToOwnText).not.toContain(PRIVATE_TITLE);
      expect(JSON.parse(otherPrivateToOwnText)).toMatchObject({ code: 'not_found' });

      expect(
        store.listAllItems().filter((item) => item.type === 'generative-ui-reference')
      ).toHaveLength(itemsBeforeDenial);
      const noInsertDb = openWorkspaceDb(dataRoot, workspace.id);
      try {
        expect(
          (
            noInsertDb.sqlite
              .prepare('SELECT COUNT(*) AS n FROM generative_presentations')
              .get() as {
              n: number;
            }
          ).n
        ).toBe(presentationCountBefore);
      } finally {
        noInsertDb.sqlite.close();
      }

      const forgedId = randomUUID();
      const forgedMessages = [
        ...nativeMessages('surface-audience', [
          { id: 'root', component: 'Text', text: { path: '/text' } },
        ]),
        {
          version: GENERATIVE_UI_PROTOCOL_VERSION,
          updateDataModel: {
            surfaceId: 'surface-audience',
            path: '/',
            value: { text: PRIVATE_TEXT },
          },
        },
      ];
      const forgedDb = openWorkspaceDb(dataRoot, workspace.id);
      try {
        applyScopedMigrations(forgedDb);
        forgedDb.sqlite
          .prepare(
            `INSERT INTO generative_presentations (
              presentation_id, workspace_id, thread_id, turn_id, item_id, created_at, actor_json,
              request_id, origin_request_id, semantic_input_hash, title, fallback_text, protocol_version,
              catalog_id, messages_json, content_digest, source_json, actions_json, observed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            forgedId,
            workspace.id,
            sharedThread.id,
            sharedTurn.id,
            `it_${forgedId}`,
            stamp,
            JSON.stringify({ kind: 'user', id: 'user_local' }),
            randomUUID(),
            null,
            `sha256:${'ab'.repeat(32)}`,
            PRIVATE_TITLE,
            PRIVATE_TEXT,
            GENERATIVE_UI_PROTOCOL_VERSION,
            GENERATIVE_UI_NATIVE_CATALOG_ID,
            JSON.stringify(forgedMessages),
            `sha256:${createHash('sha256').update(JSON.stringify(forgedMessages), 'utf8').digest('hex')}`,
            JSON.stringify({
              kind: 'item',
              itemId: ownPrivateSource.id,
              contentDigest: `sha256:${createHash('sha256').update(PRIVATE_TEXT, 'utf8').digest('hex')}`,
            }),
            JSON.stringify([{ name: 'refreshNow', componentId: 'refresh', kind: 'refresh' }]),
            stamp
          );
      } finally {
        forgedDb.sqlite.close();
      }

      for (const viewerHeaders of [memberHeaders, ownerHeaders]) {
        for (const suffix of ['', '/resource']) {
          const hidden = await app.request(
            ...operationRequest(
              suffix === '/resource' ? 'generative-ui.resource' : 'generative-ui.get',
              { workspaceId: workspace.id, presentationId: forgedId },
              {
                headers: viewerHeaders,
              }
            )
          );
          expect(hidden.status).toBe(404);
          const text = await hidden.text();
          expect(text).not.toContain(PRIVATE_TITLE);
          expect(text).not.toContain(PRIVATE_TEXT);
        }
        const hiddenRefresh = await app.request(
          ...operationRequest(
            'generative-ui.refresh',
            { workspaceId: workspace.id, presentationId: forgedId },
            {
              method: 'POST',
              headers: { ...viewerHeaders, 'content-type': 'application/json' },
              body: JSON.stringify(refreshEvent()),
            }
          )
        );
        expect(hiddenRefresh.status).toBe(404);
        expect(await hiddenRefresh.text()).not.toContain(PRIVATE_TEXT);
        const hiddenAction = await app.request(
          ...operationRequest(
            'generative-ui.action',
            { workspaceId: workspace.id, presentationId: forgedId },
            {
              method: 'POST',
              headers: {
                ...viewerHeaders,
                'content-type': 'application/json',
                'x-openkit-request-id': randomUUID(),
              },
              body: JSON.stringify(refreshEvent()),
            }
          )
        );
        expect(hiddenAction.status).toBe(404);
        expect(await hiddenAction.text()).not.toContain(PRIVATE_TEXT);
      }
      for (const credential of administratorCredentials) {
        const requestId = randomUUID();
        const destinationItems = store.listThreadItems(workspace.id, otherPrivateThread.id);
        const refusal = await app.request(
          ...operationRequest(
            'generative-ui.publish',
            { workspaceId: workspace.id },
            {
              headers: { ...credential.headers, 'x-openkit-request-id': requestId },
              body: JSON.stringify(
                itemPublishBody({
                  fallbackText: PRIVATE_TEXT,
                  itemId: ownPrivateSource.id,
                  itemText: PRIVATE_TEXT,
                  threadId: otherPrivateThread.id,
                  title: PRIVATE_TITLE,
                  turnId: otherPrivateTurn.id,
                })
              ),
            }
          )
        );
        // Soft assertions observe both credentials and every protected write even on the red run.
        expect.soft(refusal.status, credential.name).toBe(404);
        const response = await refusal.text();
        expect.soft(JSON.parse(response), credential.name).toMatchObject({ code: 'not_found' });
        expect.soft(response, credential.name).not.toContain(PRIVATE_TEXT);
        expect.soft(response, credential.name).not.toContain(PRIVATE_TITLE);
        const refusalDb = openWorkspaceDb(dataRoot, workspace.id);
        try {
          expect
            .soft(
              refusalDb.sqlite
                .prepare('SELECT * FROM generative_presentations WHERE request_id = ?')
                .all(requestId),
              credential.name
            )
            .toEqual([]);
          expect
            .soft(
              refusalDb.sqlite
                .prepare('SELECT * FROM idempotency_requests WHERE request_id = ?')
                .all(requestId),
              credential.name
            )
            .toEqual([]);
        } finally {
          refusalDb.sqlite.close();
        }
        expect
          .soft(store.listThreadItems(workspace.id, otherPrivateThread.id), credential.name)
          .toEqual(destinationItems);
      }
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
