import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnection, useCoreClient } from '../../app/core-client';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Page,
  PageHeader,
  Skeleton,
  StatusChip,
} from '../../primitives';

const channelKey = ['settings', 'discord-channel'] as const;
const notificationKey = ['settings', 'notification-deliveries'] as const;
const labels = {
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  'failed-no-send': 'Not sent',
  'delivery-unknown': 'Delivery unknown',
} as const;

/** Current user's proven Discord binding and truthful Pending Request delivery observations. */
export function ChannelsScreen() {
  const client = useCoreClient();
  const queries = useQueryClient();
  const { failed: disconnected } = useConnection();
  const [challenge, setChallenge] = useState<{ challenge: string; expiresAt: number } | null>(null);
  const status = useQuery({
    queryKey: channelKey,
    queryFn: () => client.operations['channel.discord.status']({}),
    retry: false,
  });
  const deliveries = useQuery({
    queryKey: notificationKey,
    queryFn: () => client.operations['notification.list']({ limit: 50 }),
    retry: false,
  });
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: channelKey });
    void queries.invalidateQueries({ queryKey: notificationKey });
  };
  const pair = useMutation({
    mutationFn: () => client.operations['channel.discord.pair']({}),
    onSuccess: setChallenge,
  });
  const revoke = useMutation({
    mutationFn: () => client.operations['channel.discord.revoke']({}),
    onSuccess: () => {
      setChallenge(null);
      pair.reset();
      refresh();
    },
  });
  const send = useMutation({
    mutationFn: (input: { deliveryId: string; expectedAttemptId: number | null }) =>
      client.operations['notification.send'](input),
    onSettled: refresh,
  });
  useEffect(() => {
    if (status.data?.binding) {
      setChallenge(null);
      pair.reset();
    }
  }, [status.data?.binding, pair.reset]);
  useEffect(() => {
    if (!challenge) return;
    const timeout = setTimeout(
      () => {
        setChallenge(null);
        pair.reset();
      },
      Math.max(0, challenge.expiresAt - Date.now())
    );
    return () => clearTimeout(timeout);
  }, [challenge, pair.reset]);
  const busy = pair.isPending || revoke.isPending || send.isPending;

  return (
    <Page>
      <PageHeader
        eyebrow="User"
        title="Channels"
        subtitle="Private Discord attention links and exact request responses."
        actions={
          <Button variant="quiet" onPress={refresh}>
            Refresh
          </Button>
        }
      />
      {disconnected ? (
        <StatusChip tone="notice">Disconnected. Changes are disabled.</StatusChip>
      ) : null}
      {status.isLoading ? (
        <Skeleton lines={4} />
      ) : status.isError ? (
        <ErrorBanner
          message="Could not load your Discord settings."
          onRetry={() => void status.refetch()}
        />
      ) : (
        <Card className="flex flex-col gap-3">
          <h2 className="text-sm font-bold text-fg-strong">Discord</h2>
          {!status.data?.configured ? (
            <p>Discord is not configured on this deployment.</p>
          ) : (
            <>
              <p className="text-sm text-fg-muted">
                Pairing permits attention links to your private direct messages. Discord membership
                grants no Workspace access. Approval grants stay in OpenKit.
              </p>
              {!status.data.sendingAvailable ? (
                <p className="text-sm text-fg-muted">
                  Sending is unavailable. Pairing and request responses can still be used.
                </p>
              ) : null}
              {status.data.binding ? (
                <p className="text-sm">Paired account: {status.data.binding.discordUserId}</p>
              ) : (
                <Button isDisabled={disconnected || busy} onPress={() => pair.mutate()}>
                  Pair Discord account
                </Button>
              )}
              {challenge ? (
                <div role="status" className="flex flex-col gap-2">
                  <p>
                    Send this command in a private direct message to the configured bot before{' '}
                    {new Date(challenge.expiresAt).toLocaleTimeString()}.
                  </p>
                  <code className="break-all">/openkit pair challenge:{challenge.challenge}</code>
                  <p>
                    Use Refresh after pairing. The challenge is shown only here and expires shortly.
                  </p>
                </div>
              ) : null}
              {status.data.binding || challenge ? (
                <Button
                  variant="outline"
                  isDisabled={disconnected || busy}
                  onPress={() => revoke.mutate()}
                >
                  Revoke Discord binding
                </Button>
              ) : null}
            </>
          )}
          {pair.isError || revoke.isError ? (
            <ErrorBanner message="The account change could not be completed. Refresh before a new attempt." />
          ) : null}
        </Card>
      )}
      <section className="flex flex-col gap-3" aria-label="Notification deliveries">
        <h2 className="text-sm font-bold text-fg-strong">Notification deliveries</h2>
        <p className="text-sm text-fg-muted">
          Sent means the channel acknowledged a message. It does not mean the request was read or
          decided. Email carries links only.
        </p>
        {send.isError ? (
          <ErrorBanner message="The send result could not be read. Refresh and inspect the request before retrying." />
        ) : null}
        {deliveries.isLoading ? (
          <Skeleton lines={3} />
        ) : deliveries.isError ? (
          <ErrorBanner
            message="Could not load delivery observations."
            onRetry={() => void deliveries.refetch()}
          />
        ) : !deliveries.data?.items.length ? (
          <EmptyState
            icon="chat"
            title="No current notifications"
            hint="Current Pending Request attention appears here."
          />
        ) : (
          deliveries.data.items.map((delivery) => (
            <Card key={delivery.id} className="flex flex-col gap-2">
              <p role="status" className="text-sm font-bold">
                {labels[delivery.status]}
              </p>
              <Link to={delivery.appPath} className="text-sm text-accent underline">
                Inspect request
              </Link>
              {delivery.status === 'delivery-unknown' ? (
                <p className="text-sm text-fg-muted">
                  The channel might have received this message. Automatic resend is disabled.
                </p>
              ) : null}
              {delivery.status === 'queued' || delivery.status === 'failed-no-send' ? (
                <Button
                  size="sm"
                  isDisabled={
                    disconnected || busy || !status.data?.binding || !status.data.sendingAvailable
                  }
                  onPress={() =>
                    send.mutate({
                      deliveryId: delivery.id,
                      expectedAttemptId: delivery.attempt?.id ?? null,
                    })
                  }
                >
                  {delivery.status === 'queued' ? 'Send attention link' : 'Retry send'}
                </Button>
              ) : null}
            </Card>
          ))
        )}
      </section>
    </Page>
  );
}
