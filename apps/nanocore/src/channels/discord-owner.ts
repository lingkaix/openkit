import { randomBytes } from 'node:crypto';
import {
  AnswerUserInputRequestSchema,
  canonicalJsonText,
  RespondToApprovalRequestSchema,
} from '@openkit/protocol';
import { ZodError } from 'zod';
import type { Actor } from '../auth/identity.js';
import { IdempotencyKeyConflictError, OperationError } from '../operation-error.js';
import type {
  CommunicationDisclosureKey,
  CommunicationDisclosureWrite,
} from '../storage/communication-disclosure-native.js';
import {
  admitDiscordOwners,
  discordInteractionEnvelope,
  requireChannelStorage,
  reserveDiscordInteraction,
} from '../storage/communication-inbound.js';
import type {
  ChannelInboundProof,
  ChannelInboundRefusal,
  ChannelOriginClaim,
  ChannelOriginSettlement,
} from '../storage/communication-inbound-native.js';
import type { CommunicationBinding } from '../storage/communication-pairing-native.js';
import type {
  ChannelInboundEnvelope,
  ChannelInboundOrigin,
  ChannelInboundReceipt,
  ChannelInboundState,
  CommunicationStore,
} from '../storage/communication-port.js';
import { hasOriginalReceiptDigest } from '../storage/communication-receipt.js';
import type { ControlKernelStore } from '../storage/control-kernel-port.js';
import { commandInputHash } from '../storage/control-store-input.js';
import type { StorageResult, StorageUnavailable } from '../storage/storage-owner.js';
import {
  type DiscordPendingView,
  type DiscordReply,
  discordDigest,
  discordFreshnessMs,
  discordPrivateReply,
  discordViewDigest,
  readVerifiedDiscordCommand,
  type VerifiedDiscordInteraction,
  verifyDiscordInteraction,
} from './discord-interaction.js';
import { DISCORD_AUTOMATION_NOTICE } from './discord-rest.js';

/** Typed Communication operations used by the DM path. */
export interface DiscordChannelStorage extends Pick<CommunicationStore, 'status' | 'pair'> {
  decideInbound(
    claim: ChannelOriginClaim,
    decide: () => Promise<string>
  ): Promise<
    StorageResult<
      'communication',
      { state: 'refused' | 'inspect-original' } | { state: 'completed'; reply: string }
    >
  >;
  readInboundProof(
    envelope: ChannelInboundEnvelope,
    origin: ChannelInboundOrigin | null
  ): StorageResult<'communication', ChannelInboundProof | null>;
  settleInbound(settlement: ChannelOriginSettlement): Promise<StorageResult<'communication', void>>;
  settleHandled(receipt: ChannelInboundReceipt): Promise<StorageResult<'communication', void>>;
  settleRefusal(refusal: ChannelInboundRefusal): Promise<StorageResult<'communication', void>>;
  stageEnvelope(
    envelope: ChannelInboundEnvelope,
    externalAccountId: string
  ): Promise<StorageResult<'communication', 'staged-now' | 'inspect-original' | 'conflict'>>;
  readBinding(userId: string): StorageResult<'communication', CommunicationBinding | null>;
  resolveBinding(
    externalAccountId: string
  ): StorageResult<'communication', CommunicationBinding | null>;
  revokeChallenges(actor: Actor): Promise<StorageResult<'communication', void>>;
  unbind(
    selection: Parameters<CommunicationStore['unbind']>[0],
    actor: Actor
  ): ReturnType<CommunicationStore['unbind']>;
  issueChallenge(
    input: {
      readonly userId: string;
      readonly digest: string;
      readonly expiresAt: number;
    },
    actor: Actor
  ): Promise<StorageResult<'communication', void>>;
  writeDisclosure(
    input: CommunicationDisclosureWrite
  ): Promise<StorageResult<'communication', void>>;
  readDisclosure(
    key: CommunicationDisclosureKey
  ): StorageResult<
    'communication',
    Pick<CommunicationDisclosureWrite, 'kind' | 'contentDigest'> | null
  >;
}

/** Current identity, Pending owner and native invocation dependencies supplied by Core composition. */
export interface CommunicationDiscordChannelOptions {
  readonly storage: DiscordChannelStorage;
  readonly deploymentId: string;
  readonly kernel: Pick<
    ControlKernelStore,
    | 'status'
    | 'reserveChannelInbound'
    | 'inspectChannelInbound'
    | 'bindChannelInboundOrigin'
    | 'settleChannelInbound'
  >;
  readonly applicationId: string;
  readonly publicKey: string;
  /** Trusted public App origin, independent of the inbound request Host. */
  readonly appBaseUrl: string;
  /** Returns an exact App link only after current source and audience admission. */
  readonly requestLink: (input: {
    actor: Actor;
    workspaceId: string;
    threadId: string;
    pendingRequestId: string;
  }) => string | null;
  readonly now?: () => number;
  readonly inspectPendingDecision: (
    origin: ChannelInboundOrigin,
    inputHash: string
  ) => string | null;
  /** Resolves a live ordinary actor without inheriting the pairing credential's administrator grant. */
  readonly resolveActor: (userId: string) => Actor | null;
  /** Rechecks responsible-user, exact lineage, source access and private external audience synchronously. */
  readonly inspectPending: (input: {
    readonly actor: Actor;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly pendingRequestId: string;
  }) => DiscordPendingView;
  /** Invokes the existing native engine; Pending ownership, current admission and results stay there. */
  readonly invoke: (
    id: 'question.answer' | 'approval.respond',
    input: unknown,
    actor: Actor
  ) => Promise<unknown>;
}

/** Builds a handler only with both admitted owner adapters. */
export function openCommunicationDiscordChannel(
  options: Omit<CommunicationDiscordChannelOptions, 'storage' | 'kernel'> &
    Partial<Pick<CommunicationDiscordChannelOptions, 'storage' | 'kernel'>>
):
  | StorageResult<'communication', ReturnType<typeof createCommunicationDiscordChannel>>
  | StorageUnavailable<'control-kernel'> {
  const admission = admitDiscordOwners(options.storage, options.kernel);
  return admission.state === 'ready'
    ? {
        state: 'ready',
        value: createCommunicationDiscordChannel({ ...options, ...admission.value }),
      }
    : admission;
}

type PendingTarget = Pick<ChannelInboundOrigin, 'workspaceId' | 'threadId' | 'pendingRequestId'>;
type AvailablePending = Extract<DiscordPendingView, { status: 'available' }>;

const handledReply =
  'This interaction was already handled. Inspect the request in OpenKit or inspect it again in Discord.';

function refusalReply(code: string): string {
  switch (code) {
    case 'unsupported_pairing_input':
      return 'This pairing input is unsupported. Start pairing in OpenKit.';
    case 'channel_challenge_unavailable':
      return 'Pairing challenge unavailable. Start pairing in OpenKit.';
    case 'channel_binding_conflict':
      return 'An active binding exists. Revoke it in OpenKit before pairing again.';
    default:
      return `OpenKit refused this input: ${code}. Inspect the request in OpenKit.`;
  }
}

function definiteRefusalCode(error: unknown): string | null {
  return error instanceof OperationError &&
    error.status < 500 &&
    /^[a-z0-9_-]{1,80}$/.test(error.code)
    ? error.code
    : null;
}

const unknownReply =
  'The response outcome is unknown. Inspect the request in OpenKit before a new attempt.';

/** Serves the existing signed DM commands through the communication and kernel ports. */
function createCommunicationDiscordChannel(options: CommunicationDiscordChannelOptions) {
  const { storage, kernel } = options;
  const now = options.now ?? Date.now;
  const handling = new Set<string>();
  const appUrl = new URL(options.appBaseUrl);
  if (
    appUrl.protocol !== 'https:' ||
    appUrl.origin !== options.appBaseUrl ||
    appUrl.username ||
    appUrl.password
  )
    throw new OperationError(
      'channel_configuration_invalid',
      'A public HTTPS App origin is required.',
      503
    );
  const appLink = `Open OpenKit: ${appUrl.origin}`;
  const reply = (text: string, link = appUrl.origin) =>
    discordPrivateReply(`${text}\nOpen OpenKit: ${link}`);

  function binding(actor: Actor) {
    return requireChannelStorage(storage.readBinding(actor.userId));
  }

  function admitActor(actor: Actor): void {
    if (options.resolveActor(actor.userId)?.userId !== actor.userId) {
      throw new OperationError(
        'channel_authority_unavailable',
        'Current authority unavailable.',
        403
      );
    }
  }

  /** Starts a one-use challenge without retaining the token itself. */
  async function beginPairing(actor: Actor): Promise<{ challenge: string; expiresAt: number }> {
    admitActor(actor);
    const challenge = randomBytes(32).toString('base64url');
    const expiresAt = now() + discordFreshnessMs;
    requireChannelStorage(
      await storage.issueChallenge(
        { userId: actor.userId, digest: discordDigest(challenge), expiresAt },
        actor
      )
    );
    admitActor(actor);
    return { challenge, expiresAt };
  }

  /** Revokes the selected binding or the outstanding challenges under observed absence. */
  async function revoke(actor: Actor): Promise<void> {
    admitActor(actor);
    const current = binding(actor);
    if (!current) {
      requireChannelStorage(await storage.revokeChallenges(actor));
      return;
    }
    requireChannelStorage(
      await storage.unbind({ userId: actor.userId, bindingRevision: current.revision }, actor)
    );
  }

  function currentView(actor: Actor, target: PendingTarget): AvailablePending {
    const view = options.inspectPending({ actor, ...target });
    if (view.status !== 'available')
      throw new OperationError(
        view.status === 'app-only' ? 'channel_response_not_admitted' : view.code,
        'The request is unavailable.',
        409
      );
    if (!view.responseAllowed)
      throw new OperationError('channel_response_not_admitted', 'Use the request in OpenKit.', 403);
    if (
      view.workspaceId !== target.workspaceId ||
      view.threadId !== target.threadId ||
      view.pendingRequestId !== target.pendingRequestId
    )
      throw new OperationError('channel_lineage_conflict', 'Exact request lineage differs.', 409);
    return view;
  }

  function admitBinding(actor: Actor, revision: string) {
    admitActor(actor);
    if (binding(actor)?.revision !== revision)
      throw new OperationError('channel_binding_unavailable', 'Current binding unavailable.', 403);
  }

  function admitDisclosedSource(
    actor: Actor,
    target: PendingTarget,
    revision: string,
    original: AvailablePending
  ) {
    admitBinding(actor, revision);
    if (discordViewDigest(currentView(actor, target)) !== discordViewDigest(original)) {
      throw new OperationError(
        'channel_disclosure_changed',
        'The exact effect or question changed.',
        409
      );
    }
  }

  async function settleHandled(envelope: ChannelInboundEnvelope): Promise<void> {
    const decision = requireChannelStorage(
      await kernel.settleChannelInbound(envelope, { kind: 'handled' })
    );
    if (
      decision.state !== 'settled' ||
      decision.receipt.disposition !== 'applied' ||
      decision.receipt.result.kind !== 'handled' ||
      canonicalJsonText(decision.receipt.intent) !== canonicalJsonText(envelope) ||
      !hasOriginalReceiptDigest(decision.receipt)
    ) {
      throw new OperationError('channel_receipt_unknown', unknownReply, 503);
    }
    requireChannelStorage(await storage.settleHandled(decision.receipt));
  }

  async function refuse(
    envelope: ChannelInboundEnvelope,
    origin: ChannelInboundOrigin | null,
    code: string
  ): Promise<string> {
    try {
      requireChannelStorage(await storage.settleRefusal({ envelope, origin, code }));
      // The kernel's handled receipt has no bound origin. With an already-bound
      // origin the local refusal is terminal and cannot stand in for a decision receipt.
      if (origin === null) await settleHandled(envelope);
      return refusalReply(code);
    } catch {
      return unknownReply;
    }
  }

  async function settlePendingDecision(envelope: ChannelInboundEnvelope, decisionRef: string) {
    const decision = await kernel.settleChannelInbound(envelope, {
      kind: 'pending-decision',
      decisionRef,
    });
    if (decision.state !== 'ready' || decision.value.state !== 'settled') return decision;
    const { receipt } = decision.value;
    if (
      receipt.disposition !== 'applied' ||
      receipt.result.kind !== 'pending-decision' ||
      receipt.result.decisionRef !== decisionRef ||
      canonicalJsonText(receipt.intent) !== canonicalJsonText(envelope) ||
      !hasOriginalReceiptDigest(receipt)
    ) {
      return { state: 'ready', value: { state: 'conflict' } } as const;
    }
    return decision;
  }

  async function decidePending(
    envelope: ChannelInboundEnvelope,
    actor: Actor,
    selected: CommunicationBinding,
    target: PendingTarget,
    name: 'answer' | 'deny',
    values: Readonly<Record<string, string>>,
    startClaim: () => void
  ): Promise<string> {
    const disclosureKey = {
      ...target,
      externalAccountId: selected.externalAccountId,
      bindingRevision: selected.revision,
      userId: actor.userId,
      tokenDigest: discordDigest(values.disclosure!),
    };
    const readDisclosure = () => {
      const current = requireChannelStorage(storage.readDisclosure(disclosureKey));
      if (!current)
        throw new OperationError(
          'channel_disclosure_unavailable',
          'Current disclosure unavailable.',
          409
        );
      return current;
    };
    const initial = readDisclosure();
    const view = currentView(actor, target);
    const compareDisclosure = (disclosure: typeof initial) => {
      if (disclosure.kind !== view.kind || disclosure.contentDigest !== discordViewDigest(view))
        throw new OperationError(
          'channel_disclosure_changed',
          'The exact effect or question changed.',
          409
        );
    };
    compareDisclosure(initial);
    const checkDisclosure = () => {
      admitDisclosedSource(actor, target, selected.revision, view);
      compareDisclosure(readDisclosure());
    };
    if ((name === 'answer') !== (view.kind === 'user-input'))
      throw new OperationError('unsupported_request_kind', 'Unsupported request kind.', 400);
    function parsePendingInput() {
      try {
        return name === 'answer'
          ? AnswerUserInputRequestSchema.parse({
              workspaceId: view.workspaceId,
              threadId: view.threadId,
              userInputRequestId: target.pendingRequestId,
              answers: JSON.parse(values.answers!),
              requestId: envelope.requestId,
            })
          : RespondToApprovalRequestSchema.parse({
              workspaceId: view.workspaceId,
              threadId: view.threadId,
              turnId: view.turnId,
              approvalRequestId: target.pendingRequestId,
              decision: 'denied',
              requestId: envelope.requestId,
            });
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof ZodError)
          throw new OperationError('unsupported_input', 'Unsupported input.', 400);
        throw error;
      }
    }
    const request = parsePendingInput();
    const inputHash = commandInputHash(request);
    const origin: ChannelInboundOrigin = {
      ...target,
      envelope,
      turnId: view.turnId,
      userId: actor.userId,
      bindingRevision: selected.revision,
      disclosureDigest: disclosureKey.tokenDigest,
      operation: 'answers' in request ? 'question.answer' : 'approval.respond',
    };

    startClaim();
    const result = requireChannelStorage(
      await storage.decideInbound({ origin, inputHash }, async () => {
        const bound = requireChannelStorage(await kernel.bindChannelInboundOrigin(origin));
        if (bound.state !== 'bound-now') return unknownReply;

        // The Communication posting gate remains held across this ACK and Pending admission.
        try {
          checkDisclosure();
        } catch (error) {
          const code = definiteRefusalCode(error);
          return code ? refuse(envelope, origin, code) : unknownReply;
        }

        try {
          await options.invoke(origin.operation, request, actor);
        } catch (error) {
          if (
            error instanceof IdempotencyKeyConflictError ||
            definiteRefusalCode(error) === 'idempotency_key_conflict'
          )
            return refuse(envelope, origin, 'idempotency_key_conflict');
          // The native transaction may have committed before a later stage failed.
        }
        const decisionRef = options.inspectPendingDecision(origin, inputHash);
        if (!decisionRef) return unknownReply;
        const settled = requireChannelStorage(await settlePendingDecision(envelope, decisionRef));
        return settled.state === 'settled' &&
          (await acknowledgeDecision(settled.receipt, inputHash))
          ? 'OpenKit accepted the response. Inspect the request in OpenKit for its current decision and execution outcome.'
          : unknownReply;
      })
    );
    if (result.state === 'refused') return refuse(envelope, null, 'channel_authority_unavailable');
    return result.state === 'completed' ? result.reply : unknownReply;
  }

  /** Confirms the kernel's actual bound origin before the local settlement transaction. */
  async function acknowledgeDecision(
    receipt: ChannelInboundReceipt,
    inputHash: string
  ): Promise<boolean> {
    const inspection = await reserveDiscordInteraction(kernel, receipt.intent, 'inspect-original');
    if (inspection.state !== 'inspect-original' || inspection.original.state !== 'settled')
      return false;
    const original = inspection.original;
    return (
      original.receipt.receiptDigest === receipt.receiptDigest &&
      recoverSettlement(original, inputHash)
    );
  }

  /** Recovers local settlement when the kernel commit survived its acknowledgement. */
  async function recoverSettlement(
    { origin, receipt }: Extract<ChannelInboundState, { state: 'settled' }>,
    expectedInputHash?: string
  ): Promise<boolean> {
    if (!origin || receipt.disposition !== 'applied' || receipt.result.kind !== 'pending-decision')
      return false;
    const proof = requireChannelStorage(storage.readInboundProof(receipt.intent, origin));
    if (proof?.state === 'redacted')
      return (
        expectedInputHash === undefined &&
        proof.refusalCode === null &&
        proof.receiptDigest === receipt.receiptDigest
      );
    if (
      !proof?.inputHash ||
      proof.refusalCode ||
      (expectedInputHash !== undefined && proof.inputHash !== expectedInputHash)
    )
      return false;
    if (
      proof.receiptDigest === null &&
      options.inspectPendingDecision(origin, proof.inputHash) !== receipt.result.decisionRef
    )
      return false;
    requireChannelStorage(
      await storage.settleInbound({ origin, inputHash: proof.inputHash, receipt })
    );
    return true;
  }

  /** Checks a committed original decision without reopening its effect. */
  async function recoverOriginal(
    origin: ChannelInboundOrigin,
    inputHash: string,
    externalAccountId: string
  ): Promise<boolean> {
    const actor = options.resolveActor(origin.userId);
    const selected = requireChannelStorage(storage.resolveBinding(externalAccountId));
    if (
      !actor ||
      selected?.userId !== origin.userId ||
      selected.revision !== origin.bindingRevision ||
      !options.requestLink({ ...origin, actor })
    )
      return false;

    const decisionRef = options.inspectPendingDecision(origin, inputHash);
    if (!decisionRef) return false;
    const result = requireChannelStorage(await settlePendingDecision(origin.envelope, decisionRef));
    return result.state === 'settled' && acknowledgeDecision(result.receipt, inputHash);
  }

  async function replay(
    original: ChannelInboundState,
    envelope: ChannelInboundEnvelope,
    externalAccountId: string
  ): Promise<string> {
    if (handling.has(envelope.requestId)) return unknownReply;
    try {
      if (original.state === 'settled') {
        if (
          original.origin === null &&
          original.receipt.disposition === 'applied' &&
          original.receipt.result.kind === 'handled'
        ) {
          const proof = requireChannelStorage(storage.readInboundProof(envelope, null));
          if (!proof) return unknownReply;
          if (proof.receiptDigest !== original.receipt.receiptDigest)
            requireChannelStorage(await storage.settleHandled(original.receipt));
          return proof.refusalCode ? refusalReply(proof.refusalCode) : handledReply;
        }
        return (await recoverSettlement(original)) ? handledReply : unknownReply;
      }
      if (original.state === 'reserved') {
        const proof = requireChannelStorage(storage.readInboundProof(envelope, null));
        if (!proof?.refusalCode) return unknownReply;
        await settleHandled(envelope);
        return refusalReply(proof.refusalCode);
      }
      if (original.state === 'origin-bound') {
        const proof = requireChannelStorage(storage.readInboundProof(envelope, original.origin));
        if (proof?.refusalCode) return refusalReply(proof.refusalCode);
        if (!proof?.inputHash) return unknownReply;
        if (await recoverOriginal(original.origin, proof.inputHash, externalAccountId))
          return handledReply;
      }
      return unknownReply;
    } catch {
      return unknownReply;
    }
  }

  async function handleVerified(input: VerifiedDiscordInteraction): Promise<DiscordReply> {
    const verified = readVerifiedDiscordCommand(input, options);
    if (verified.state === 'ping') return { type: 1 };
    if (verified.state === 'outside-dm')
      return reply(
        'Use a private DM with the OpenKit bot. Unsupported input must be handled in OpenKit.'
      );
    if (verified.state === 'unsupported')
      return reply('This interaction is unsupported. Use OpenKit.');
    const { eventId, command } = verified;

    const readiness = storage.status();
    if (readiness.state !== 'ready') requireChannelStorage(readiness);
    const kernelReadiness = kernel.status();
    if (kernelReadiness.state !== 'ready') requireChannelStorage(kernelReadiness);
    const envelope = discordInteractionEnvelope(options.deploymentId, eventId, input.payloadDigest);
    let admission: Awaited<ReturnType<typeof reserveDiscordInteraction>>;
    try {
      const staged = requireChannelStorage(await storage.stageEnvelope(envelope, command.user.id));
      admission = await reserveDiscordInteraction(kernel, envelope, staged);
    } catch (error) {
      if (error instanceof OperationError && error.code === 'channel_storage_unavailable')
        throw error;
      return reply(unknownReply);
    }
    if (admission.state === 'conflict')
      return reply('Interaction identity conflict. Inspect the request in OpenKit.');
    if (admission.state !== 'reserved-now') {
      return reply(
        admission.state === 'inspect-original'
          ? await replay(admission.original, envelope, command.user.id)
          : unknownReply
      );
    }

    let posting = false;
    handling.add(envelope.requestId);
    try {
      const subcommand = command.data.options[0]!;
      const values = Object.create(null) as Record<string, string>;
      for (const option of subcommand.options) {
        if (Object.hasOwn(values, option.name))
          throw new OperationError('unsupported_input', 'Duplicate input.', 400);
        values[option.name] = option.value;
      }
      const names = Object.keys(values).sort().join(',');
      const externalAccountId = command.user.id;
      if (subcommand.name === 'pair') {
        if (names !== 'challenge') {
          return reply(await refuse(envelope, null, 'unsupported_pairing_input'));
        }
        posting = true;
        try {
          requireChannelStorage(
            await storage.pair({
              envelope,
              externalAccountId,
              challengeDigest: discordDigest(values.challenge!),
            })
          );
        } catch (error) {
          const code = definiteRefusalCode(error);
          // Both codes are pre-mutation checks in the atomic pairing transaction.
          if (code === 'channel_challenge_unavailable' || code === 'channel_binding_conflict')
            return reply(await refuse(envelope, null, code));
          throw error;
        }
        await settleHandled(envelope);
        return reply(
          'Discord account paired. Current Core authority is checked for each response.'
        );
      }

      const expectedNames =
        subcommand.name === 'inspect' || subcommand.name === 'approve'
          ? 'request,thread,workspace'
          : subcommand.name === 'answer'
            ? 'answers,disclosure,request,thread,workspace'
            : 'disclosure,request,thread,workspace';
      if (names !== expectedNames)
        throw new OperationError('unsupported_input', 'Unsupported input.', 400);
      const selected = requireChannelStorage(storage.resolveBinding(externalAccountId));
      if (!selected)
        throw new OperationError(
          'channel_binding_unavailable',
          'Current binding unavailable.',
          403
        );
      const actor = { userId: selected.userId, kind: 'session' } as const;
      admitActor(actor);
      const target = {
        workspaceId: values.workspace!,
        threadId: values.thread!,
        pendingRequestId: values.request!,
      };

      if (
        subcommand.name === 'approve' ||
        options.inspectPending({ actor, ...target }).status === 'app-only'
      ) {
        const approval = subcommand.name === 'approve';
        await settleHandled(envelope);
        const link =
          options.resolveActor(actor.userId)?.userId === actor.userId &&
          binding(actor)?.revision === selected.revision &&
          (approval || options.inspectPending({ actor, ...target }).status === 'app-only')
            ? options.requestLink({ actor, ...target })
            : null;
        return reply(
          approval
            ? 'Approval grants require the complete App confirmation.'
            : DISCORD_AUTOMATION_NOTICE,
          link ?? appUrl.origin
        );
      }

      if (subcommand.name !== 'inspect')
        return reply(
          await decidePending(envelope, actor, selected, target, subcommand.name, values, () => {
            posting = true;
          })
        );

      const view = currentView(actor, target);
      const token = randomBytes(32).toString('base64url');
      const contentDigest = discordViewDigest(view);
      const text = `${view.content}\nDigest: ${contentDigest}\nDisclosure: ${token}\nUse this disclosure only for this exact request. It expires in five minutes.`;
      if (text.length + appLink.length + 1 > 2_000)
        throw new OperationError(
          'channel_disclosure_too_large',
          'The complete request requires OpenKit.',
          400
        );
      posting = true;
      requireChannelStorage(
        await storage.writeDisclosure({
          ...target,
          userId: actor.userId,
          externalAccountId,
          bindingRevision: selected.revision,
          tokenDigest: discordDigest(token),
          kind: view.kind,
          contentDigest,
          expiresAt: now() + discordFreshnessMs,
        })
      );
      admitDisclosedSource(actor, target, selected.revision, view);
      await settleHandled(envelope);
      admitDisclosedSource(actor, target, selected.revision, view);
      return reply(text);
    } catch (error) {
      const code = definiteRefusalCode(error);
      return reply(!posting && code ? await refuse(envelope, null, code) : unknownReply);
    } finally {
      handling.delete(envelope.requestId);
    }
  }

  return {
    beginPairing,
    binding,
    revoke,
    handleVerified,
    /** Authenticates raw input before its external account or event identity is used. */
    handleSignedInteraction(input: { body: Uint8Array; signature: string; timestamp: string }) {
      return handleVerified(
        verifyDiscordInteraction({
          ...input,
          applicationId: options.applicationId,
          publicKey: options.publicKey,
          now: now(),
        })
      );
    },
  };
}
