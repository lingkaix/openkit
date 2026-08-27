/**
 * Sample A2UI declarations for the Tier-C generative shell demo (board 13).
 *
 * Fixtures only — not a live agent data path. JSON-shaped objects are data;
 * they are never evaluated as code.
 */

import type { A2UIDocument } from './catalog';

/**
 * Fully whitelisted ready-state sample: a generated setup card with switches
 * and action buttons (board 13 "Weekly pricing refresh").
 */
export const READY_SAMPLE: A2UIDocument = {
  root: {
    type: 'Card',
    children: [
      {
        type: 'Text',
        props: { strong: true },
        content: 'Weekly pricing refresh',
      },
      {
        type: 'Select',
        props: {
          label: 'Day',
          selectedKey: 'monday',
          placeholder: 'Monday',
          items: [
            { id: 'monday', label: 'Monday' },
            { id: 'friday', label: 'Friday' },
          ],
        },
      },
      {
        type: 'TextField',
        props: { label: 'Time', value: '9:00' },
      },
      {
        type: 'Switch',
        props: {
          label: 'Email me a summary of changes',
          selected: true,
        },
      },
      {
        type: 'Switch',
        props: {
          label: 'Skip the email when nothing changed',
          selected: true,
        },
      },
      {
        type: 'Button',
        props: { label: 'Cancel', variant: 'quiet', size: 'sm' },
      },
      {
        type: 'Button',
        props: { label: 'Create automation', variant: 'accent', size: 'sm' },
      },
    ],
  },
};

/**
 * Fallback-state sample: includes an unknown `Chart` type that must degrade to
 * plain content (never an error card).
 */
export const FALLBACK_SAMPLE: A2UIDocument = {
  root: {
    type: 'Card',
    children: [
      {
        type: 'Text',
        content:
          "This view asked for a chart type that isn't in the OpenKit catalog yet — here's the same data as a table.",
      },
      {
        type: 'Chart',
        content:
          'Competitor    April    July\nNorthwind     $49      $59\nBrightline    $79      $74\nClearlake     $120     $120',
      },
    ],
  },
};

/**
 * Minimal document with a single unknown root — used by unit tests for the
 * plain-content fallback predicate.
 */
export const unknownComponentDocument: A2UIDocument = FALLBACK_SAMPLE;

/**
 * Attributed result item after the ready sample is "submitted" (board 13).
 */
export const RESULT_ITEM_SAMPLE: A2UIDocument = {
  root: {
    type: 'ItemCard',
    props: {
      kind: 'positive',
      title: 'Automation created',
      meta: 'Weekly pricing refresh — Mondays 9:00',
    },
    children: [
      {
        type: 'Text',
        content: 'Runs in Market research. Change it anytime in Automations.',
      },
    ],
  },
};
