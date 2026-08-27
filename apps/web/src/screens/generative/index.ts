/**
 * Tier-C generative UI / A2UI render shell (WP-9, board 13).
 *
 * In-thread whitelist renderer with three-state fallback. Flag-disabled; no live
 * agent-declared data path and no arbitrary-code execution.
 */
export { A2UI_CATALOG, type A2UIDocument, type A2UINode, isWhitelisted } from './catalog';
export {
  FALLBACK_SAMPLE,
  READY_SAMPLE,
  RESULT_ITEM_SAMPLE,
  unknownComponentDocument,
} from './fixtures';
export { GenerativeScreen } from './GenerativeScreen';
export { A2UIRenderer, PlainContentFallback, renderA2UINode } from './render';
export {
  documentHasUnknown,
  type GenerativeRenderState,
  resolveRenderState,
} from './states';
