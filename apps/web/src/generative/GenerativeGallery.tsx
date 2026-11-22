import type { ReactComponentImplementation } from '@a2ui/react/v0_9';
import { A2uiSurface } from '@a2ui/react/v0_9';
import { MessageProcessor } from '@a2ui/web_core/v0_9';
import { GENERATIVE_UI_NATIVE_CATALOG_ID } from '@openkit/app-api-schemas';
import { useMemo } from 'react';
import { Specimen, SpecimenGroup } from '../primitives';
import { nativeGenerativeCatalog } from './native-catalog';

const SURFACE_ID = 'components-gallery';

/**
 * Fixture A2UI v0.9 messages that use every native catalog type once: Card, Column,
 * Row, List, Text, TextField, CheckBox and Button. Fixture data only; the gallery
 * reads no server data and its actions go nowhere.
 */
const FIXTURE_MESSAGES = [
  {
    version: 'v0.9',
    createSurface: {
      surfaceId: SURFACE_ID,
      catalogId: GENERATIVE_UI_NATIVE_CATALOG_ID,
      sendDataModel: false,
    },
  },
  {
    version: 'v0.9',
    updateComponents: {
      surfaceId: SURFACE_ID,
      components: [
        { id: 'root', component: 'Card', child: 'body' },
        {
          id: 'body',
          component: 'Column',
          children: ['title', 'summary', 'steps', 'time', 'notify', 'actions'],
        },
        { id: 'title', component: 'Text', text: 'Weekly pricing refresh' },
        {
          id: 'summary',
          component: 'Text',
          text: 'Checks three competitor pages every Monday and drafts a change note.',
        },
        { id: 'steps', component: 'List', children: ['step-1', 'step-2'] },
        { id: 'step-1', component: 'Text', text: 'Read the saved pricing pages' },
        { id: 'step-2', component: 'Text', text: 'Draft a note when a price changes' },
        {
          id: 'time',
          component: 'TextField',
          label: 'Run at',
          value: { path: '/schedule/time' },
        },
        {
          id: 'notify',
          component: 'CheckBox',
          label: 'Email me a summary',
          value: { path: '/schedule/notify' },
        },
        { id: 'actions', component: 'Row', children: ['save'] },
        {
          id: 'save',
          component: 'Button',
          child: 'save-label',
          action: { event: { name: 'save' } },
        },
        { id: 'save-label', component: 'Text', text: 'Save schedule' },
      ],
    },
  },
  {
    version: 'v0.9',
    updateDataModel: {
      surfaceId: SURFACE_ID,
      path: '/',
      value: { schedule: { time: '09:00', notify: true } },
    },
  },
];

/**
 * Generative UI specimens for the Components page: the native A2UI catalog rendered
 * from fixtures through the same host renderers that live Threads use, so
 * agent-produced UI is reviewed with the same tokens as every other primitive.
 */
export function GenerativeGallery() {
  const surface = useMemo(() => {
    const processor = new MessageProcessor<ReactComponentImplementation>(
      [nativeGenerativeCatalog],
      () => undefined,
      { version: 'v0.9' }
    );
    processor.processMessages(structuredClone(FIXTURE_MESSAGES) as never);
    return processor.model.getSurface(SURFACE_ID) ?? null;
  }, []);

  return (
    <SpecimenGroup id="gallery-generative" title="Generative UI">
      <Specimen title="Native catalog">
        {surface ? <A2uiSurface surface={surface} /> : null}
      </Specimen>
    </SpecimenGroup>
  );
}
