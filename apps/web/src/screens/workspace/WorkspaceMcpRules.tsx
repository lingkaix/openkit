import type { OperationOutput } from '@openkit/app-api-schemas';
import { useState } from 'react';
import { Button, ErrorBanner, TextField } from '../../primitives';
import { useUpdateMcpBinding } from './data';

/** Edits existing Workspace rules at their observed binding and catalog revisions. */
export function WorkspaceMcpRules({
  workspaceId,
  revision,
  server,
  blocked,
  onRefresh,
  refreshBlocked,
}: {
  workspaceId: string;
  revision: number;
  server: OperationOutput<'catalog.read'>['mcp'][number];
  blocked: boolean;
  onRefresh: () => Promise<boolean>;
  refreshBlocked: boolean;
}) {
  const [allowed, setAllowed] = useState(server.allowedTools.join(', '));
  const [approval, setApproval] = useState(server.approvalRequiredTools.join(', '));
  const [denied, setDenied] = useState(server.deniedTools.join(', '));
  const change = useUpdateMcpBinding();
  const disabled = blocked || change.isPending || change.isError;
  const tools = (value: string) =>
    value
      .split(',')
      .map((tool) => tool.trim())
      .filter(Boolean);
  return (
    <section aria-label={`${server.displayName} tool rules`} className="flex flex-col gap-3">
      <p className="text-xs text-fg-muted">
        Save changes only after review. Allowing a tool does not approve a captured invocation.
      </p>
      <TextField
        label={`${server.displayName} allowed tools`}
        description={`Current allowed tools: ${server.allowedTools.join(', ') || 'None'}`}
        value={allowed}
        onChange={setAllowed}
        isDisabled={disabled}
      />
      <TextField
        label={`${server.displayName} approval-required tools`}
        description={`Current approval-required tools: ${server.approvalRequiredTools.join(', ') || 'None'}`}
        value={approval}
        onChange={setApproval}
        isDisabled={disabled}
      />
      <TextField
        label={`${server.displayName} denied tools`}
        description={`Current denied tools: ${server.deniedTools.join(', ') || 'None'}`}
        value={denied}
        onChange={setDenied}
        isDisabled={disabled}
      />
      <Button
        size="sm"
        isDisabled={disabled || tools(allowed).length === 0}
        onPress={() =>
          change.mutate({
            workspaceId,
            mcpId: server.id,
            expectedRevision: revision,
            bindingRevision: server.bindingRevision,
            enabled: server.enabled,
            allowedTools: tools(allowed),
            approvalRequiredTools: tools(approval),
            deniedTools: tools(denied),
            schemaPolicy: server.schemaPolicy ?? 'tracking',
            timeoutMs: server.timeoutMs ?? 60_000,
          })
        }
      >
        Save {server.displayName} tool rules
      </Button>
      {change.isSuccess ? <p role="status">Tool rules saved.</p> : null}
      {change.isError ? (
        <>
          <ErrorBanner message="Tool-rule save could not be confirmed. Refresh and inspect the current binding before another change." />
          <Button
            size="sm"
            isDisabled={refreshBlocked}
            onPress={async () => {
              if (await onRefresh()) change.reset();
            }}
          >
            Refresh {server.displayName} rules
          </Button>
        </>
      ) : null}
    </section>
  );
}
