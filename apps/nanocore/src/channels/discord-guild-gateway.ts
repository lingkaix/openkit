import { z } from 'zod';
import {
  type DiscordGroupMention,
  type DiscordGroupMentionBinding,
  selectDiscordGroupMention,
} from './discord-group-mention.js';

const gatewayUrl = 'wss://gateway.discord.gg/?v=10&encoding=json';
const guildMessageIntents = (1 << 0) | (1 << 9); // GUILDS and GUILD_MESSAGES; no Message Content.
const configurationClose = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const packet = z.object({
  op: z.number().int(),
  t: z.string().nullish(),
  s: z.number().int().nonnegative().nullish(),
  d: z.unknown().optional(),
});
const hello = z.object({ heartbeat_interval: z.number().int().positive().max(120_000) });
const ready = z.object({
  user: z.object({ id: z.string(), bot: z.literal(true) }),
  session_id: z.string().min(1),
  resume_gateway_url: z.string(),
});

interface Session {
  readonly id: string;
  readonly url: string;
  sequence: number;
}

/** Only accept a Discord Gateway host before forwarding the credential on Resume. */
function resumeUrl(candidate: string): string {
  try {
    const url = new URL(candidate);
    if (
      url.protocol === 'wss:' &&
      /^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password
    )
      return `${url.origin}/?v=10&encoding=json`;
  } catch {
    // Keep the fixed Gateway endpoint if the supplied address is unusable.
  }
  return gatewayUrl;
}

/** A fixtureable, single Reports Gateway connection. It never stores or logs Gateway payloads. */
export function startDiscordGuildGateway(options: {
  readonly botUserId: string;
  readonly resolveBotToken: () => Promise<string | null>;
  readonly readBinding: (route: {
    guildId: string;
    channelId: string;
  }) => DiscordGroupMentionBinding | null;
  /** The native owner revalidates the binding and handles freshness, replay and persistence. */
  readonly onMention: (mention: DiscordGroupMention) => Promise<void>;
  readonly onFault: (
    reason: 'credential-unavailable' | 'gateway-rejected' | 'ingress-failed'
  ) => void;
  readonly connect?: (url: string) => WebSocket;
}): () => void {
  let stopped = false;
  let socket: WebSocket | undefined;
  let session: Session | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let establishment: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  function stop() {
    stopped = true;
    session = undefined;
    clearTimeout(reconnect);
    clearTimeout(heartbeat);
    clearTimeout(establishment);
    const previous = socket;
    socket = undefined;
    previous?.close(1000);
  }

  function retry(current?: WebSocket) {
    if (stopped || socket !== current) return;
    socket = undefined;
    clearTimeout(heartbeat);
    clearTimeout(establishment);
    // A normal close invalidates the Discord session. Preserve it for Resume.
    current?.close(4000);
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(failures++, 6));
    reconnect = setTimeout(() => void open(), delay);
  }

  async function open() {
    let token: string | null;
    try {
      token = await options.resolveBotToken();
    } catch {
      token = null;
    }
    if (stopped) return;
    if (!token) {
      stop();
      options.onFault('credential-unavailable');
      return;
    }
    const credential = token;
    const resume = session;
    let current: WebSocket;
    try {
      current =
        options.connect?.(resume?.url ?? gatewayUrl) ?? new WebSocket(resume?.url ?? gatewayUrl);
    } catch {
      retry();
      return;
    }
    socket = current;
    establishment = setTimeout(() => retry(current), 15_000); // Covers HELLO and READY/RESUMED.
    let lastSeen = resume?.sequence;
    const pending = new Map<number, boolean>();
    function checkpoint(seq: number, done: boolean) {
      if (!session || socket !== current || seq <= session.sequence) return;
      pending.set(seq, done);
      for (const [next, complete] of pending) {
        if (!complete) break;
        pending.delete(next);
        session.sequence = next;
      }
      if (pending.size > 128) retry(current); // Resume instead of buffering without a durable cursor.
    }
    let greeted = false;
    let authenticated = false;
    let awaitingAck = false;

    function send(op: number, data: unknown): boolean {
      try {
        current.send(JSON.stringify({ op, d: data }));
        return true;
      } catch {
        retry(current);
        return false;
      }
    }

    function beat() {
      awaitingAck = true;
      return send(1, lastSeen ?? null);
    }

    current.addEventListener('close', (event) => {
      if (socket !== current) return;
      if (configurationClose.has(event.code)) {
        stop();
        options.onFault('gateway-rejected');
        return;
      }
      if (event.code === 4007 || event.code === 4009) session = undefined;
      retry(current);
    });
    current.addEventListener('error', () => retry(current));
    current.addEventListener('message', (event) => {
      if (socket !== current || typeof event.data !== 'string') return;
      let received: unknown;
      try {
        received = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = packet.safeParse(received);
      if (!parsed.success) return;
      const { op, t, s, d } = parsed.data;
      if (op === 10 && !greeted) {
        const greeting = hello.safeParse(d);
        if (!greeting.success) return retry(current);
        greeted = true;
        clearTimeout(heartbeat);
        if (resume) {
          if (!send(6, { token: credential, session_id: resume.id, seq: resume.sequence })) return;
          authenticated = true; // Replayed dispatches can precede RESUMED; READY already verified this session.
        } else if (
          !send(2, {
            token: credential,
            intents: guildMessageIntents,
            properties: { os: process.platform, browser: 'OpenKit', device: 'OpenKit' },
          })
        )
          return;
        const interval = greeting.data.heartbeat_interval;
        const tick = () => {
          if (socket !== current) return;
          if (awaitingAck) return retry(current);
          if (beat()) heartbeat = setTimeout(tick, interval);
        };
        heartbeat = setTimeout(tick, Math.random() * interval);
        return;
      }
      if (!greeted) return;
      if (op === 1) {
        beat();
        return;
      }
      if (op === 11) {
        awaitingAck = false;
        return;
      }
      if (op === 7 || op === 9) {
        if (op === 9 && d !== true) session = undefined;
        return retry(current);
      }
      if (op !== 0 || s == null) return;
      if (t === 'READY') {
        const value = ready.safeParse(d);
        if (!value.success || value.data.user.id !== options.botUserId) {
          stop();
          options.onFault('gateway-rejected');
          return;
        }
        session = {
          id: value.data.session_id,
          url: resumeUrl(value.data.resume_gateway_url),
          sequence: s,
        };
        authenticated = true;
        lastSeen = s;
        clearTimeout(establishment);
        failures = 0;
        return;
      }
      if (!authenticated || !session || (lastSeen !== undefined && s <= lastSeen)) return;
      lastSeen = s;
      if (t === 'RESUMED') {
        clearTimeout(establishment);
        failures = 0;
      }
      if (t !== 'MESSAGE_CREATE' || !d || typeof d !== 'object') return checkpoint(s, true);
      if (
        !('guild_id' in d) ||
        typeof d.guild_id !== 'string' ||
        !('channel_id' in d) ||
        typeof d.channel_id !== 'string'
      )
        return checkpoint(s, true);
      const failed = () => {
        if (socket !== current) return;
        retry(current);
        options.onFault('ingress-failed');
      };
      try {
        const binding = options.readBinding({ guildId: d.guild_id, channelId: d.channel_id });
        const mention = binding ? selectDiscordGroupMention(d, options.botUserId, binding) : null;
        if (!mention) return checkpoint(s, true);
        checkpoint(s, false);
        if (socket === current)
          void options.onMention(mention).then(() => checkpoint(s, true), failed);
      } catch {
        failed();
      }
    });
  }

  void open();
  return stop;
}
