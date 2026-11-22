import { lazy, Suspense, useState } from 'react';
import { Button as AriaButton, Disclosure, DisclosurePanel, Heading } from 'react-aria-components';
import { useLocation } from 'react-router-dom';
import { ThemePicker } from '../../app/ThemePicker';
import {
  ActionButton,
  ActionGroup,
  AssistantMessage,
  Button,
  ButtonGroup,
  CountBadge,
  Icon,
  ItemCard,
  NavRow,
  Page,
  PageHeader,
  Picker,
  Skeleton,
  StatusLight,
  TextField,
  UserMessage,
} from '../../primitives';

const AllComponents = lazy(() => import('./AllComponents'));

/** Deep link that opens Appearance with "All components" expanded. */
export const ALL_COMPONENTS_PATH = '/settings/appearance/components';

/**
 * A compact, representative look of the product in the current theme: the action
 * hierarchy, a field row, a navigation row, status, a message pair and a decision
 * card. It renders fixtures only and follows the theme choice immediately.
 */
function AppearancePreview() {
  return (
    <div className="grid grid-cols-1 gap-4 rounded-ok-lg border border-separator p-4 min-[800px]:grid-cols-2">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <ButtonGroup>
            <Button variant="accent">Approve plan</Button>
            <Button variant="secondary">Not now</Button>
          </ButtonGroup>
          <ActionGroup aria-label="Preview actions">
            <ActionButton isQuiet>
              <Icon name="retry" />
              Retry
            </ActionButton>
            <ActionButton isQuiet aria-label="More" title="More">
              <Icon name="more" />
            </ActionButton>
          </ActionGroup>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Thread name" defaultValue="Spring newsletter" />
          <Picker
            label="Model"
            items={[
              { id: 'balanced', label: 'Balanced' },
              { id: 'fast', label: 'Fast' },
            ]}
            defaultSelectedKey="balanced"
          />
        </div>
        <div className="flex flex-col gap-1">
          <NavRow
            icon="home"
            label="Needs you"
            trailing={<CountBadge count={2} label="need you" tone="notice" />}
          />
          <NavRow icon="chat" label="Spring newsletter" active />
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusLight tone="informative">Working</StatusLight>
          <StatusLight tone="notice">Needs you</StatusLight>
          <StatusLight tone="positive">Done</StatusLight>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <UserMessage author="Sam" isSelf>
          Plan the spring newsletter with a pricing teaser.
        </UserMessage>
        <AssistantMessage hue="scout" initials="SC" author="Scout" time="now">
          I drafted three stories. The pricing teaser needs your call.
        </AssistantMessage>
        <ItemCard
          decision
          kind="notice"
          title="Approve the plan?"
          meta="3 steps · 1 needs your approval"
          actions={
            <>
              <Button size="sm" variant="accent">
                Approve
              </Button>
              <Button size="sm" variant="secondary">
                Change something
              </Button>
            </>
          }
        />
      </div>
    </div>
  );
}

/**
 * Settings → Appearance: the persisted theme choice, a live preview that follows it,
 * and the full component gallery as a collapsed, lazily loaded disclosure. The page
 * reads no server data (WEB-UX principle P14); `/settings/appearance/components`
 * opens the gallery expanded.
 */
export function AppearanceScreen() {
  const { pathname } = useLocation();
  const [galleryOpen, setGalleryOpen] = useState(pathname === ALL_COMPONENTS_PATH);

  return (
    <Page>
      <PageHeader
        eyebrow="Settings"
        title="Appearance"
        subtitle="Choose how OpenKit looks. The preview follows your choice."
      />
      <section aria-labelledby="appearance-theme" className="flex flex-col gap-3">
        <h2 id="appearance-theme" className="text-lg font-heading text-fg-strong">
          Theme
        </h2>
        <ThemePicker />
      </section>
      <section aria-labelledby="appearance-preview" className="flex flex-col gap-3">
        <h2 id="appearance-preview" className="text-lg font-heading text-fg-strong">
          Preview
        </h2>
        <AppearancePreview />
      </section>
      <Disclosure isExpanded={galleryOpen} onExpandedChange={setGalleryOpen}>
        <Heading level={2} className="m-0">
          <AriaButton
            slot="trigger"
            className="flex w-full items-center gap-2 rounded-ok py-2 text-left text-lg font-heading text-fg-strong outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-solid data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
          >
            <Icon
              name="chevron-right"
              className={galleryOpen ? 'rotate-90 transition-transform' : 'transition-transform'}
            />
            All components
          </AriaButton>
        </Heading>
        <DisclosurePanel>
          {galleryOpen ? (
            <Suspense fallback={<Skeleton lines={4} />}>
              <div className="pt-3">
                <AllComponents />
              </div>
            </Suspense>
          ) : null}
        </DisclosurePanel>
      </Disclosure>
    </Page>
  );
}
