import { policyDigest } from '@openkit/protocol/digest';
import {
  type GatewayDecisionAction,
  GatewayDecisionActionSchema,
} from '../llm/gateway-decision.js';

export interface DiscordPublicationFacts {
  readonly originId: string;
  readonly botUserId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly audienceRef: string;
  readonly authorityRevisionRefs: readonly string[];
  readonly influenceDigest: string;
  readonly renderedBodyRef: string;
  readonly content: string;
  readonly review: Pick<
    GatewayDecisionAction,
    'principal' | 'onBehalfOf' | 'target' | 'influenceSources'
  >;
}

/** Closed proposal bytes for the existing Pending owner. This function never approves or sends. */
export function prepareDiscordPublication(facts: DiscordPublicationFacts) {
  const { content, review } = facts;
  const references = {
    originId: facts.originId,
    botUserId: facts.botUserId,
    guildId: facts.guildId,
    channelId: facts.channelId,
    audienceRef: facts.audienceRef,
    authorityRevisionRefs: [...facts.authorityRevisionRefs],
    influenceDigest: facts.influenceDigest,
    renderedBodyRef: facts.renderedBodyRef,
  };
  if ([...content].length > 2000 || Buffer.byteLength(content, 'utf8') > 4096 || !content.trim())
    return { kind: 'invalid-answer' } as const;
  if (
    Object.values(references).some((ref) => !ref.length) ||
    references.authorityRevisionRefs.some((ref) => !ref.length) ||
    review.influenceSources.length === 0
  )
    return { kind: 'unresolved' } as const;
  const dispatch = { content, allowed_mentions: { parse: [] as string[] }, flags: 4 };
  const proof = { operation: 'channel.publish', ...references } as const;
  const action = GatewayDecisionActionSchema.safeParse({
    principal: review.principal,
    onBehalfOf: review.onBehalfOf,
    target: review.target,
    influenceSources: review.influenceSources,
    operation: proof.operation,
    destinationAudience: [references.audienceRef],
  });
  if (!action.success) return { kind: 'unresolved' } as const;
  const candidate = { ...action.data, payload: JSON.stringify({ origin: proof, dispatch }) };
  const governedIntent = { ...proof, actionDigest: policyDigest(candidate) };
  const bounded = GatewayDecisionActionSchema.safeParse(candidate);
  return {
    kind: 'proposal' as const,
    governedIntent,
    preview: dispatch,
    // Oversize evidence requires human review of the unchanged bytes, never a clipped model action.
    securityReviewAction:
      bounded.success && Buffer.byteLength(JSON.stringify(bounded.data), 'utf8') <= 8192
        ? bounded.data
        : null,
  };
}
