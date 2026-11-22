import { createContext, useContext, useState } from 'react';
import {
  Button as AriaButton,
  UNSTABLE_ToastQueue as AriaToastQueue,
  TooltipTrigger,
} from 'react-aria-components';
import { ActionButton, ActionGroup, DisclosureButton, ToggleButton } from './ActionButton';
import { ArtifactRow } from './ArtifactRow';
import { Avatar } from './Avatar';
import { Badge, CountBadge } from './Badge';
import { Button, ButtonGroup } from './Button';
import { ChannelTag } from './ChannelTag';
import { Composer } from './Composer';
import { Dialog, DialogFooter, Modal } from './Dialog';
import { CodeView, DiffView } from './DiffView';
import { Icon } from './Icon';
import { ItemCard } from './ItemCard';
import { KanbanCard, KanbanColumn } from './Kanban';
import { MaterialEditor } from './MaterialEditor';
import { Menu } from './Menu';
import { AssistantMessage, UserMessage } from './Message';
import { NavRow } from './NavRow';
import { PhaseStepper } from './PhaseStepper';
import { Picker } from './Picker';
import { Meter, Progress } from './Progress';
import { RadioGroup } from './RadioGroup';
import { StatusLight } from './StatusLight';
import { Switch } from './Switch';
import { EmptyState, InlineAlert, Skeleton } from './states';
import { Table } from './Table';
import { Tabs } from './Tabs';
import { Tag } from './Tag';
import { TextField } from './TextField';
import { type QueuedToast, Toast, ToastProvider } from './Toast';
import { Tooltip } from './Tooltip';
import { TurnSeparator } from './TurnSeparator';

/** Isolated preview queue that never consumes app-level notifications. */
const galleryToastQueue = new AriaToastQueue<string | QueuedToast>();

/**
 * Preview-only gallery option: render every specimen once per color scheme, light
 * beside dark. It never touches the persisted Appearance choice.
 */
export const GallerySideBySide = createContext(false);

/** One labeled specimen block in the component sheet. */
export function Specimen({ title, children }: { title: string; children: React.ReactNode }) {
  const sideBySide = useContext(GallerySideBySide);
  return (
    <section className="flex flex-col gap-3 rounded-ok-lg border border-separator p-4">
      <h4 className="text-eyebrow font-bold tracking-eyebrow text-fg-muted">{title}</h4>
      {sideBySide ? (
        <div className="grid grid-cols-1 overflow-hidden rounded-ok border border-separator min-[800px]:grid-cols-2">
          <div className="ok-scheme-light flex min-w-0 flex-col gap-3 bg-canvas p-3">
            {children}
          </div>
          <div className="ok-scheme-dark flex min-w-0 flex-col gap-3 bg-canvas p-3">{children}</div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">{children}</div>
      )}
    </section>
  );
}

/**
 * One named group of specimens. Phone width is one column; two columns start at
 * the 800px shell break.
 */
export function SpecimenGroup({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  const sideBySide = useContext(GallerySideBySide);
  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-3">
      <h3 id={`${id}-heading`} className="text-lg font-heading text-fg-strong">
        {title}
      </h3>
      <div className={`grid grid-cols-1 gap-4 ${sideBySide ? '' : 'min-[800px]:grid-cols-2'}`}>
        {children}
      </div>
    </section>
  );
}

/** Semantic color roles shown in Foundations, as Tailwind utilities (tokens.css). */
const FOUNDATION_SWATCHES: [label: string, swatch: string][] = [
  ['Canvas', 'bg-canvas'],
  ['Card', 'bg-card'],
  ['Sunken', 'bg-sunken'],
  ['Elevated', 'bg-elevated'],
  ['Text', 'bg-fg'],
  ['Text strong', 'bg-fg-strong'],
  ['Text muted', 'bg-fg-muted'],
  ['Accent', 'bg-accent'],
  ['Accent text', 'bg-accent-content'],
  ['Focus', 'bg-focus'],
  ['Border', 'bg-border'],
  ['Separator', 'bg-separator'],
  ['Informative', 'bg-info-fg'],
  ['Notice', 'bg-notice-fg'],
  ['Positive', 'bg-positive-fg'],
  ['Negative', 'bg-negative-fg'],
  ['Neutral', 'bg-neutral-fg'],
  ['Needs you', 'bg-attention-dot'],
];

/** Every semantic color role, always light beside dark (WEB-UX A1). */
function Foundations() {
  return (
    <SpecimenGroup id="gallery-foundations" title="Foundations">
      <section className="flex flex-col gap-3 rounded-ok-lg border border-separator p-4 min-[800px]:col-span-2">
        <h4 className="text-eyebrow font-bold tracking-eyebrow text-fg-muted">Color</h4>
        <div className="grid grid-cols-1 overflow-hidden rounded-ok border border-separator min-[800px]:grid-cols-2">
          {(['light', 'dark'] as const).map((scheme) => (
            <div key={scheme} className={`ok-scheme-${scheme} flex flex-col gap-2 bg-canvas p-3`}>
              <p className="text-xs font-bold text-fg-muted">
                {scheme === 'light' ? 'Light' : 'Dark'}
              </p>
              <ul className="grid grid-cols-2 gap-x-4 gap-y-2 min-[480px]:grid-cols-3">
                {FOUNDATION_SWATCHES.map(([label, swatch]) => (
                  <li key={label} className="flex min-w-0 items-center gap-2 text-xs text-fg">
                    <span
                      className={`size-5 shrink-0 rounded-ok-sm border border-separator ${swatch}`}
                    />
                    {label}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </SpecimenGroup>
  );
}

/** Segmented lens: an ActionGroup of ToggleButtons, one selected. */
function GalleryLens() {
  const [lens, setLens] = useState<'summary' | 'all'>('summary');
  return (
    <ActionGroup aria-label="Timeline lens" size="sm">
      <ToggleButton size="sm" isSelected={lens === 'summary'} onChange={() => setLens('summary')}>
        Summary
      </ToggleButton>
      <ToggleButton size="sm" isSelected={lens === 'all'} onChange={() => setLens('all')}>
        All activity
      </ToggleButton>
    </ActionGroup>
  );
}

/** A section toggle: a disclosure, never a full-width pill (F22). */
function GalleryDisclosure() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <DisclosureButton isExpanded={open} onPress={() => setOpen(!open)}>
        Notebook history
      </DisclosureButton>
      {open ? <p className="text-sm text-fg-muted">Three published revisions.</p> : null}
    </div>
  );
}

/**
 * Component sheet (board 11): every primitive once, grouped in review order, so it
 * can be reviewed for fidelity against the applicable design references. It renders
 * fixtures only and reads no server data (Appearance → All components, WEB-UX P14).
 */
export function Gallery() {
  return (
    <div className="flex flex-col gap-8">
      <Foundations />
      <SpecimenGroup id="gallery-actions" title="Actions">
        <Specimen title="Buttons">
          <ButtonGroup>
            <Button variant="accent">Approve plan</Button>
            <Button variant="primary">Continue</Button>
            <Button variant="secondary">Not now</Button>
            <Button variant="secondary" fillStyle="fill">
              Back
            </Button>
            <Button variant="negative">Delete</Button>
            <Button variant="negative" fillStyle="outline">
              Disable
            </Button>
          </ButtonGroup>
          <ButtonGroup>
            <Button size="sm" variant="secondary">
              Small
            </Button>
            <Button variant="accent" fillStyle="outline">
              Preview
            </Button>
            <Button variant="accent" isDisabled>
              Disabled
            </Button>
            <Button size="lg" variant="accent">
              Large
            </Button>
          </ButtonGroup>
        </Specimen>
        <Specimen title="Action buttons">
          <ActionGroup aria-label="Reply actions">
            <ActionButton>
              <Icon name="retry" />
              Retry
            </ActionButton>
            <ActionButton aria-label="Open" title="Open">
              <Icon name="view" />
            </ActionButton>
            <ActionButton aria-label="More" title="More">
              <Icon name="more" />
            </ActionButton>
          </ActionGroup>
          <ActionGroup aria-label="Row actions" size="sm">
            <ActionButton isQuiet size="sm">
              Open
            </ActionButton>
            <ActionButton isQuiet size="sm" aria-label="Retry step" title="Retry step">
              <Icon name="retry" />
            </ActionButton>
            <ActionButton isQuiet size="sm" aria-label="More for this step" title="More">
              <Icon name="more" />
            </ActionButton>
          </ActionGroup>
        </Specimen>
        <Specimen title="Toggle buttons">
          <GalleryLens />
        </Specimen>
        <Specimen title="Disclosure">
          <GalleryDisclosure />
        </Specimen>
      </SpecimenGroup>
      <SpecimenGroup id="gallery-fields" title="Fields">
        <Specimen title="Fields">
          {/* One form row: TextField, Picker and an M Button share one height (P7, F23). */}
          <fieldset
            aria-label="Field row"
            className="m-0 min-w-0 border-0 p-0 flex flex-wrap items-end gap-3"
          >
            <TextField label="Workspace name" placeholder="Market research" />
            <Picker
              label="Model"
              items={[
                { id: 'opus', label: 'Claude Opus 4.8' },
                { id: 'sonnet', label: 'Claude Sonnet 5' },
              ]}
              defaultSelectedKey="opus"
            />
            <Button variant="secondary">Save</Button>
          </fieldset>
          <TextField
            label="Brief"
            description="One or two sentences the Assistant starts from."
            placeholder="Summarize the launch"
          />
          <TextField label="Owner email" defaultValue="not-an-email" isInvalid />
          <TextField label="Server URL" defaultValue="https://example.test" isDisabled />
        </Specimen>
        <Specimen title="Switch and radio group">
          <Switch defaultSelected>Ask before spending</Switch>
          <Switch>Notify me on finish</Switch>
          <Switch isDisabled>Share with the Workspace</Switch>
          <RadioGroup
            label="Reply length"
            defaultValue="short"
            items={[
              { id: 'short', label: 'Short' },
              { id: 'detailed', label: 'Detailed' },
              { id: 'report', label: 'Full report' },
            ]}
          />
        </Specimen>
      </SpecimenGroup>
      <SpecimenGroup id="gallery-navigation" title="Navigation">
        <Specimen title="Nav rows">
          <NavRow
            icon="home"
            label="Overview"
            trailing={<CountBadge count={3} label="need you" />}
          />
          <NavRow icon="chat" label="Chat" active />
          <NavRow label="Market research" indent={1} icon="folder" />
        </Specimen>
        <Specimen title="Tabs">
          <Tabs
            aria-label="Goal lens"
            defaultSelectedKey="thread"
            items={[
              { id: 'thread', label: 'Thread', content: 'Thread content' },
              { id: 'plan', label: 'Plan', content: 'Plan content' },
              { id: 'board', label: 'Board', content: 'Board content' },
            ]}
          />
        </Specimen>
      </SpecimenGroup>
      <SpecimenGroup id="gallery-overlays" title="Overlays">
        <Specimen title="Dialog">
          <p className="text-sm text-fg-muted">
            S2 standard dialog: 22px title, 10px radius, widths S 400 / M 480 / L 640, footer
            Buttons on the right. Below 800px it is a full-height sheet.
          </p>
          <ButtonGroup>
            <Modal size="S" trigger={<Button variant="secondary">Open dialog</Button>}>
              <Dialog title="Confirm change">
                <p>This modal delegates focus and dismissal to React Aria.</p>
                <DialogFooter>
                  <Button slot="close" variant="secondary">
                    Cancel
                  </Button>
                  <Button slot="close">Done</Button>
                </DialogFooter>
              </Dialog>
            </Modal>
            <Modal size="L" trigger={<Button variant="secondary">Open large dialog</Button>}>
              <Dialog title="Edit route" closeLabel="Close">
                <TextField label="Route name" defaultValue="Primary reasoning" />
                <DialogFooter>
                  <Button slot="close" variant="secondary">
                    Cancel
                  </Button>
                  <Button slot="close">Save</Button>
                </DialogFooter>
              </Dialog>
            </Modal>
          </ButtonGroup>
        </Specimen>
        <Specimen title="Menu">
          <div className="flex flex-wrap items-center gap-2">
            <Menu
              label="Goal actions"
              sections={[
                {
                  id: 'goal',
                  items: [
                    { id: 'prioritize', label: 'Prioritize', icon: 'goal', shortcut: 'P' },
                    { id: 'edit', label: 'Edit brief', icon: 'edit', shortcut: 'E' },
                  ],
                },
                {
                  id: 'share',
                  title: 'Share',
                  items: [
                    {
                      id: 'copy-link',
                      label: 'Copy link',
                      icon: 'connect',
                      description: 'Members of this Workspace',
                    },
                    { id: 'archive', label: 'Archive', icon: 'archive', isDisabled: true },
                  ],
                },
              ]}
              onAction={() => {}}
            />
            <Menu
              label="More actions"
              icon="more"
              items={[
                { id: 'rename', label: 'Rename' },
                { id: 'archive', label: 'Archive' },
              ]}
              onAction={() => {}}
            />
          </div>
        </Specimen>
      </SpecimenGroup>
      <SpecimenGroup id="gallery-data" title="Data">
        <Specimen title="Table">
          <Table
            aria-label="Worker readiness"
            columns={[
              { id: 'worker', label: 'Worker' },
              { id: 'status', label: 'Status' },
            ]}
            rows={[
              {
                id: 'scout',
                cells: {
                  worker: 'Scout',
                  status: <StatusLight tone="positive">Ready</StatusLight>,
                },
              },
              {
                id: 'quill',
                cells: { worker: 'Quill', status: <StatusLight tone="notice">Busy</StatusLight> },
              },
            ]}
            rowActions={{
              items: [
                { id: 'open', label: 'Open' },
                { id: 'pause', label: 'Pause' },
              ],
              label: (row) => `Actions for ${String(row.cells.worker)}`,
              onAction: () => {},
            }}
          />
        </Specimen>
        <Specimen title="Progress + meter">
          <Progress label="Material upload" minValue={0} maxValue={100} value={60} />
          <Progress label="Index (small)" size="S" minValue={0} maxValue={100} value={30} />
          <Meter label="Workspace storage" minValue={0} maxValue={100} value={65} />
        </Specimen>
      </SpecimenGroup>
      <SpecimenGroup id="gallery-feedback" title="Feedback">
        <Specimen title="Status lights">
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            <StatusLight tone="informative">Running</StatusLight>
            <StatusLight tone="notice">Needs review</StatusLight>
            <StatusLight tone="positive">Approved</StatusLight>
            <StatusLight tone="negative">Failed</StatusLight>
            <StatusLight tone="neutral">Draft</StatusLight>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            <StatusLight tone="positive" size="sm">
              Ready
            </StatusLight>
            <StatusLight tone="negative" size="sm">
              Disconnected
            </StatusLight>
          </div>
        </Specimen>
        <Specimen title="Badges and tags">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>git</Badge>
            <Badge tone="informative">3 files</Badge>
            <Badge tone="accent">New</Badge>
            <CountBadge count={4} label="need you" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Tag>Market research</Tag>
            <ChannelTag channel="Slack" />
          </div>
        </Specimen>
        <Specimen title="In-line alerts">
          <InlineAlert message="Couldn't reach the local runtime." onRetry={() => {}} />
          <InlineAlert
            variant="notice"
            title="Vault is locked."
            message="Account slots stay unavailable until the Vault is unlocked."
            action={
              <Button variant="secondary" size="sm">
                Open Vault
              </Button>
            }
          />
          <InlineAlert variant="informative" message="Changes apply to new Turns only." />
        </Specimen>
        <Specimen title="System states">
          <Skeleton lines={3} />
          <EmptyState
            icon="chat"
            title="Nothing here yet"
            hint="Start a chat to begin."
            action={<Button size="sm">New chat</Button>}
          />
        </Specimen>
        <Specimen title="Toast + icons">
          <Toast
            message="Scout finished the teardown."
            onAction={() => {}}
            onDismissAction={() => {}}
          />
          <ToastProvider queue={galleryToastQueue} />
          {/* S2 workflow icon sizes S / M / L: 16 / 20 / 22 desktop, 18 / 24 / 28 touch. */}
          <fieldset
            aria-label="Icon sizes"
            className="m-0 min-w-0 border-0 p-0 flex flex-wrap items-end gap-3 text-fg"
          >
            <Icon name="search" size="sm" label="Search, small" />
            <Icon name="search" size="md" label="Search, medium" />
            <Icon name="search" size="lg" label="Search, large" />
            <Icon name="settings" label="Settings" />
            <Icon name="agents" label="Agents" />
            <Icon name="generative" label="Generative" />
            <Icon name="disconnected" label="Disconnected" />
          </fieldset>
          <TooltipTrigger delay={0} closeDelay={0}>
            <AriaButton className="self-start rounded-ok text-sm font-medium text-accent-content underline outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus">
              What is a Turn?
            </AriaButton>
            <Tooltip>One request and everything the Assistant did to answer it.</Tooltip>
          </TooltipTrigger>
        </Specimen>
      </SpecimenGroup>
      <SpecimenGroup id="gallery-conversation" title="Conversation">
        <Specimen title="Avatars + attribution">
          <div className="flex flex-wrap items-center gap-3">
            <Avatar hue="scout" initials="SC" name="Scout" />
            <Avatar hue="quill" initials="QU" name="Quill" />
            <Avatar hue="ledger" initials="LG" name="Ledger" />
            <Avatar hue="pixel" initials="PX" name="Pixel" />
            <Avatar hue="you" initials="SW" name="You" />
            <ChannelTag channel="Claude Desktop" />
          </div>
        </Specimen>
        <Specimen title="Conversation">
          <UserMessage author="Sam" isSelf>
            Draft a competitive teardown of the top three tools.
          </UserMessage>
          <AssistantMessage
            hue="scout"
            initials="SC"
            author="Scout"
            time="2m ago"
            via="Claude Desktop"
          >
            On it — I'll gather pricing, positioning, and gaps, then summarize.
          </AssistantMessage>
          <TurnSeparator label="Turn 2 · retry" note="re-ran after the source timed out" />
          <ItemCard
            decision
            kind="notice"
            title="Awaiting plan approval"
            meta="6 steps · 2 need your approval"
            actions={
              <>
                <Button size="sm" variant="accent">
                  Approve
                </Button>
                <Button size="sm" variant="secondary">
                  Request changes
                </Button>
              </>
            }
          />
          <ItemCard kind="informative" title="Plan updated" meta="6 steps · Scout" />
          <ItemCard kind="neutral" title="teardown.md" meta="File change · edited" />
        </Specimen>
        <Specimen title="Composer">
          <Composer />
        </Specimen>
      </SpecimenGroup>
      <SpecimenGroup id="gallery-work" title="Work">
        <Specimen title="Phase stepper">
          <PhaseStepper current="plan" gate />
          <PhaseStepper current="execute" />
        </Specimen>
        <Specimen title="Board (kanban lens)">
          <div className="flex gap-3 overflow-x-auto">
            <KanbanColumn title="In progress" count={1}>
              <KanbanCard
                title="Collect pricing"
                hue="scout"
                initials="SC"
                worker="Scout"
                meta="step 2"
              />
            </KanbanColumn>
            <KanbanColumn title="Review" count={1}>
              <KanbanCard
                title="Final review with you"
                hue="you"
                initials="SW"
                worker="You"
                meta="in review"
              />
            </KanbanColumn>
          </div>
        </Specimen>
        <Specimen title="Artifacts">
          <ArtifactRow
            name="teardown.md"
            icon="file"
            added={128}
            removed={4}
            time="just now"
            onOpen={() => {}}
          />
          <ArtifactRow name="pricing.csv" icon="file" added={40} time="1m ago" />
        </Specimen>
        <Specimen title="Text + material">
          <CodeView label="Worker output" value={'first line\n  second line'} />
          <DiffView
            before={'# Release\nDraft'}
            after={'# Release\nReady'}
            beforeLabel="Saved revision"
            afterLabel="Worker proposal"
          />
          <MaterialEditor
            label="Release notes"
            kind="markdown"
            initialValue={'# Release\n'}
            onSave={() => {}}
          />
        </Specimen>
      </SpecimenGroup>
    </div>
  );
}
