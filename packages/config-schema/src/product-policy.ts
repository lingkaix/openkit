import { z } from 'zod';

/** Closed V1 product-operation to NGAC access-right registry. */
export const PRODUCT_OPERATION_ACCESS_RIGHTS = {
  'api.call': 'ar:core-api-call',
  'administration.configuration.apply': 'ar:worker-git-read-maintenance-apply',
  'approval.respond': 'ar:approval-respond',
  'artifact.read': 'ar:artifact-read',
  'artifact.write': 'ar:artifact-write',
  'audit.read': 'ar:audit-read',
  'deployment.recover': 'ar:deployment-recover',
  'invitation.respond': 'ar:invitation-respond',
  'knowledge.propose': 'ar:knowledge-propose',
  'knowledge.read': 'ar:knowledge-read',
  'knowledge.write': 'ar:knowledge-write',
  'llm.gateway.use': 'ar:llm-gateway-use',
  'membership.manage': 'ar:membership-manage',
  'network.egress': 'ar:network-egress',
  'review.apply': 'ar:review-apply',
  'runtime.launch': 'ar:runtime-launch',
  'thread.read': 'ar:thread-read',
  'tool.grant': 'ar:tool-grant',
  'tool.use': 'ar:tool-use',
  'turn.run': 'ar:turn-run',
  'vault.admin': 'ar:vault-admin',
  'vault.use': 'ar:vault-use',
  'workspace.configure': 'ar:workspace-configure',
  'workspace.export': 'ar:workspace-export',
  'workspace.leave': 'ar:workspace-leave',
  'workspace.lifecycle': 'ar:workspace-lifecycle',
  'workspace.read': 'ar:workspace-read',
  'workspace.write': 'ar:workspace-write',
} as const;

/** Product operation registered by the V1 authorization vocabulary. */
export type ProductOperation = keyof typeof PRODUCT_OPERATION_ACCESS_RIGHTS;

/** Registered operations accepted in authored resource Policy; unknown rights fail closed. */
export const ProductOperationSchema = z.enum(
  Object.keys(PRODUCT_OPERATION_ACCESS_RIGHTS) as [ProductOperation, ...ProductOperation[]]
);
