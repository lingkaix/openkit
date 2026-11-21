import { existsSync } from 'node:fs';
import { prepareCommunicationOwner } from '../app.js';
import {
  inspectChannelInboundReceipt,
  inspectPairingAuditReceipt,
} from './command-request-records.js';
import { communicationOwner } from './communication-owner.js';
import type { ChannelInboundOrigin } from './communication-port.js';
import type { ControlKernelStore } from './control-kernel-port.js';
import {
  bindChannelInboundOriginInDb,
  relayPairingAuditInDb,
  reserveChannelInboundInDb,
  settleChannelInboundInDb,
} from './control-store-admission.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import { type CoreDb, serverStoragePath } from './db.js';
import { coreDbPath } from './fs-layout.js';

type Kernel = Pick<
  ControlKernelStore,
  | 'status'
  | 'reserveChannelInbound'
  | 'inspectChannelInbound'
  | 'bindChannelInboundOrigin'
  | 'settleChannelInbound'
  | 'inspectPairingAudit'
  | 'relayPairingAudit'
>;

function ready<Value>(value: Value) {
  return { state: 'ready' as const, value };
}

/** The fixture owns a separate Core connection. Its caller substitutes only Core transport. */
export function communicationKernelFixture(
  db: CoreDb,
  readPendingDecision: (original: ChannelInboundOrigin) => string | null,
  asNativeWriter: <Value>(effect: () => Value) => Value
): Kernel {
  const write = async <Value>(transaction: () => Value) =>
    ready(asNativeWriter(() => db.sqlite.transaction(transaction).immediate()));
  return {
    status: () => ({ owner: 'control-kernel', state: 'ready' }),
    reserveChannelInbound: (envelope) => write(() => reserveChannelInboundInDb(db, envelope, true)),
    inspectChannelInbound: async (key) => ready(inspectChannelInboundReceipt(db, key, true)),
    bindChannelInboundOrigin: (origin) =>
      write(() => bindChannelInboundOriginInDb(db, origin, true)),
    settleChannelInbound: (envelope, outcome) =>
      write(() => settleChannelInboundInDb(db, envelope, outcome, true, readPendingDecision)),
    inspectPairingAudit: async (intent) => ready(inspectPairingAuditReceipt(db, intent, true)),
    relayPairingAudit: (intent, event) =>
      write(() => relayPairingAuditInDb(db, intent, event, true)),
  };
}

/** Opens the genuine Communication worker on a fresh or previously provisioned fixture root. */
export async function openCommunicationFixture(
  coreDb: CoreDb,
  mode: 'local' | 'server',
  kernel: Kernel
) {
  const root = coreDb.dataRoot;
  const path = coreDbPath(root);
  const writer = getControlStoreWorkerClient();
  await writer.open({
    database: `core:${path}`,
    path,
    create: false,
    initialize: 'core',
    productOwner: { kind: 'server' },
    dataRoot: root,
  });
  if (!existsSync(serverStoragePath(root, 'communication'))) {
    const provisioned = await writer.provisionServerOwner(root, communicationOwner);
    if (provisioned.state !== 'ready') throw new Error(JSON.stringify(provisioned));
  }
  const binding = await prepareCommunicationOwner({ coreDb, mode, kernel });
  if (binding.state !== 'ready') throw new Error(JSON.stringify(binding));
  return binding.value;
}
