import { z } from 'zod';

/**
 * Closed kind values for item delta stream updates.
 */
export const ItemDeltaKindSchema = z.enum([
  'text-delta',
  'indexed-text-delta',
  'part-started',
  'output-delta',
  'snapshot-updated',
  'progress-updated',
  'request-started',
  'request-resolved',
  'interaction-delta',
  'artifact-updated',
  'knowledge-injection-updated',
]);

/**
 * Closed kind value for an item delta stream update.
 */
export type ItemDeltaKind = z.infer<typeof ItemDeltaKindSchema>;
