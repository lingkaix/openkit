import { OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { describe, expect, it } from 'vitest';
import { PUBLIC_OPERATION_ACCESS } from '../../../nanocore/src/auth/operation-access';
import {
  type DispositionRecord,
  dispositionGuardErrors,
  type EvaluatedAccess,
  includedOrdinaryUserOperationIds,
  tierASurfaceIds,
} from './operation-disposition';
import { OPERATION_DISPOSITIONS } from './operation-dispositions';

const EVENTS_KEY = 'GET /api/workspaces/:workspaceId/threads/:threadId/events';

function guard(
  dispositions: readonly DispositionRecord[],
  access: Readonly<Record<string, EvaluatedAccess>> = PUBLIC_OPERATION_ACCESS
) {
  const included = includedOrdinaryUserOperationIds(access, OPERATION_DEFINITIONS);
  return {
    included,
    errors: dispositionGuardErrors({
      included,
      dispositions,
      tierASurfaceIds: tierASurfaceIds(),
    }),
  };
}

/** The method and exact path the composed Core Client sends for one Thread event stream. */
async function composedEventRequest(): Promise<{ method: string; path: string }> {
  const sent: { method: string; path: string }[] = [];
  const client = createCoreClient({
    baseUrl: 'http://core.test',
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      sent.push({ method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname });
      return new Response(null, { status: 204 });
    },
  });
  const stream = client.core
    .subscribeTurnEvents({ workspaceId: 'w-1', threadId: 't-1', turnId: 'turn-1' })
    [Symbol.asyncIterator]();
  await stream.next();
  await stream.return?.();
  const [request] = sent;
  if (!request) throw new Error('the composed client sent no event request');
  return request;
}

/** A transport key bound to fixed identifiers: `GET /a/:x/b` -> `{ GET, /a/w-1/b }`. */
function expectedRequest(routeKey: string): { method: string; path: string } {
  const [method = '', path = ''] = routeKey.split(' ');
  return {
    method,
    path: path.replace(':workspaceId', 'w-1').replace(':threadId', 't-1'),
  };
}

describe('operation disposition guard', () => {
  it('admits the committed inventory', async () => {
    const result = guard(OPERATION_DISPOSITIONS);
    expect(result.errors).toEqual([]);
    expect(result.included.length).toBe(OPERATION_DISPOSITIONS.length);
    const transports = result.included.filter((id) => / \//.test(id));
    expect(transports).toEqual([EVENTS_KEY]);
    expect(await composedEventRequest()).toEqual(expectedRequest(EVENTS_KEY));
    // Every other included key is a published operation in the catalog the Core Client composes.
    for (const id of result.included.filter((key) => !transports.includes(key))) {
      expect(Object.hasOwn(OPERATION_DEFINITIONS, id), id).toBe(true);
    }
  });

  it('fails a missing key, a duplicate key, and an unknown disposition', () => {
    const [sample, ...rest] = OPERATION_DISPOSITIONS;
    expect(sample).toBeDefined();
    if (!sample) return;
    expect(guard(rest).errors).toContain(`missing disposition for ${sample.key}`);

    const duplicated = guard([
      ...OPERATION_DISPOSITIONS,
      { key: sample.key, disposition: sample.disposition },
    ]);
    expect(duplicated.errors).toContain(`duplicate disposition for ${sample.key}`);

    const unknown = guard(
      OPERATION_DISPOSITIONS.map((row, index) =>
        index === 0 ? { key: row.key, disposition: { kind: 'retired' } } : row
      )
    );
    expect(unknown.errors).toContain(`unknown disposition for ${sample.key}`);
  });

  it('reads scope from the evaluated access record for definitions and transports', () => {
    for (const key of [EVENTS_KEY, 'approval.respond']) {
      const current = PUBLIC_OPERATION_ACCESS[key];
      expect(current?.scope, key).not.toBe('server');
      const access = {
        ...PUBLIC_OPERATION_ACCESS,
        [key]: { ...current, scope: 'server', authentication: 'deployment-admin' },
      };
      expect(guard(OPERATION_DISPOSITIONS, access).errors).toContain(
        `leftover disposition for ${key}`
      );
    }
  });

  it('fails when the evaluated catalog includes a transport with no disposition', () => {
    const extra = 'GET /api/workspaces/:workspaceId/threads/:threadId/after-the-loop';
    const access = { ...PUBLIC_OPERATION_ACCESS, [extra]: PUBLIC_OPERATION_ACCESS[EVENTS_KEY] };
    expect(guard(OPERATION_DISPOSITIONS, access).errors).toContain(
      `missing disposition for ${extra}`
    );
  });

  it('matches the composed request exactly, not by prefix', async () => {
    const actual = await composedEventRequest();
    expect(actual).toEqual(expectedRequest(EVENTS_KEY));
    expect(actual).not.toEqual(expectedRequest(`${EVENTS_KEY}-alternate`));
    expect(actual).not.toEqual(expectedRequest(EVENTS_KEY.replace('GET', 'POST')));
  });

  it('rejects a mixed shape, an unknown field and a roadmap issue that is not an issue number', () => {
    const live = OPERATION_DISPOSITIONS.find((row) => row.disposition.kind === 'live');
    const roadmap = OPERATION_DISPOSITIONS.find((row) => row.disposition.kind === 'roadmap');
    expect(live?.disposition.surface).toBeTruthy();
    expect(roadmap?.disposition.issue).toBeTruthy();
    if (!live || !roadmap) return;
    const replace = (key: string, next: DispositionRecord) =>
      OPERATION_DISPOSITIONS.map((row) => (row.key === key ? next : row));

    const mixed = guard(
      replace(live.key, {
        key: live.key,
        disposition: { kind: 'live', surface: live.disposition.surface, issue: 954 },
      })
    );
    expect(mixed.errors).toContain(`unknown field issue in disposition for ${live.key}`);

    // #885 item 3: a spread that adds a field is not a closed record.
    const spread = guard(
      replace(live.key, {
        ...live,
        disposition: { ...live.disposition, extra: true },
      } as DispositionRecord)
    );
    expect(spread.errors).toContain(`unknown field extra in disposition for ${live.key}`);
    const outer = guard(replace(live.key, { ...live, note: 'x' } as DispositionRecord));
    expect(outer.errors).toContain(`unknown field note in disposition for ${live.key}`);

    for (const issue of [0, -1, 9.5]) {
      const bad = guard(
        replace(roadmap.key, { key: roadmap.key, disposition: { kind: 'roadmap', issue } })
      );
      expect(bad.errors).toContain(
        `roadmap issue ${issue} is not an issue number for ${roadmap.key}`
      );
    }
    const legacy = guard(
      replace(roadmap.key, {
        key: roadmap.key,
        disposition: { kind: 'roadmap', item: 'R048' },
      } as DispositionRecord)
    );
    expect(legacy.errors).toContain(`unknown field item in disposition for ${roadmap.key}`);
  });

  it('fails a live or workflow surface that is not Tier A', () => {
    for (const kind of ['live', 'workflow']) {
      const row = OPERATION_DISPOSITIONS.find((candidate) => candidate.disposition.kind === kind);
      if (!row) throw new Error(`no ${kind} disposition`);
      const result = guard(
        OPERATION_DISPOSITIONS.map((candidate) =>
          candidate.key === row.key
            ? { key: row.key, disposition: { kind, surface: 'generative' } }
            : candidate
        )
      );
      expect(result.errors).toContain(`${kind} surface generative is not Tier A for ${row.key}`);
    }
  });
});
