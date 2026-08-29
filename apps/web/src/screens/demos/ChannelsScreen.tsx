import {
  Button,
  Card,
  Eyebrow,
  Icon,
  Page,
  PageHeader,
  StatusChip,
  Switch,
} from '../../primitives';
import { type ChannelRow, type ChannelTravelSetting, useChannels } from './data';

/**
 * Channels settings (WP-8, board 16).
 *
 * Connected channels, outbound travel preferences, and an interrupt preview.
 * Data comes from `useChannels()` sample fixtures while unpublished; the app route is omitted until the channels contract stabilizes.
 */
export function ChannelsScreen() {
  const { data } = useChannels();
  const { channels, travel } = data;

  return (
    <Page>
      <PageHeader
        title="Channels"
        subtitle="Take OpenKit where you already work. Interrupts travel out — and are decidable in place."
      />

      <section className="flex flex-col gap-3" aria-labelledby="channels-connected">
        <Eyebrow>
          <span id="channels-connected">Connected channels</span>
        </Eyebrow>
        <Card className="p-0">
          {channels.map((channel) => (
            <ChannelListRow key={channel.id} channel={channel} />
          ))}
        </Card>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="channels-travel">
        <Eyebrow>
          <span id="channels-travel">What travels out</span>
        </Eyebrow>
        <Card className="p-0">
          {travel.map((setting) => (
            <TravelRow key={setting.id} setting={setting} />
          ))}
        </Card>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="channels-preview">
        <Eyebrow>
          <span id="channels-preview">How an interrupt looks in a channel</span>
        </Eyebrow>
        <div className="max-w-md rounded-ok-lg border border-separator bg-card p-3.5 shadow-ok-card">
          <div className="flex gap-2.5">
            <span
              className="grid size-[30px] shrink-0 grid-cols-2 gap-0.5 overflow-hidden rounded-ok"
              aria-hidden
            >
              <span className="bg-brand-1" />
              <span className="bg-brand-2" />
              <span className="bg-brand-3" />
              <span className="bg-brand-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-fg-strong">
                OpenKit
                <span className="ml-1.5 text-xs font-normal text-fg-muted">16:12</span>
              </p>
              <p className="mt-1.5 text-sm leading-snug text-fg">
                Scout asks to sign in to the vendor pricing portal —{' '}
                <strong className="font-bold text-fg-strong">Market research</strong>, waiting 24m.
              </p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="outline">
                  Not now
                </Button>
                <Button size="sm">Allow</Button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </Page>
  );
}

/**
 * Connected / available channel row.
 *
 * @param props Channel sample.
 */
function ChannelListRow({ channel }: { channel: ChannelRow }) {
  return (
    <div className="flex items-center gap-3 border-b border-separator px-3.5 py-2.5 last:border-b-0">
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-ok ${
          channel.connected ? 'bg-info-bg text-info-fg' : 'bg-sunken text-fg-muted'
        }`}
      >
        <Icon name={channel.name === 'Email digest' ? 'chat' : 'connect'} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-fg-strong">{channel.name}</p>
        <p className="text-xs text-fg-muted">{channel.meta}</p>
      </div>
      {channel.connected ? (
        <>
          <StatusChip tone="positive" dot>
            Connected
          </StatusChip>
          <Switch defaultSelected={channel.enabled} aria-label={`Toggle ${channel.name}`}>
            <span className="sr-only">Enabled</span>
          </Switch>
        </>
      ) : (
        <Button size="sm" variant="outline">
          Connect
        </Button>
      )}
    </div>
  );
}

/**
 * Outbound travel preference row.
 *
 * @param props Travel setting sample.
 */
function TravelRow({ setting }: { setting: ChannelTravelSetting }) {
  return (
    <div className="flex items-center gap-3 border-b border-separator px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg-strong">{setting.title}</p>
        <p className="text-xs text-fg-muted">{setting.help}</p>
      </div>
      <Switch defaultSelected={setting.enabled} aria-label={setting.title}>
        <span className="sr-only">{setting.title}</span>
      </Switch>
    </div>
  );
}
