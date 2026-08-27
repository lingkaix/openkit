import { UNSTABLE_ToastQueue as AriaToastQueue } from 'react-aria-components';
import {
  ArtifactRow,
  AssistantMessage,
  Avatar,
  Button,
  ChannelTag,
  CodeView,
  Composer,
  ContextChip,
  CountBadge,
  Dialog,
  DiffView,
  EmptyState,
  ErrorBanner,
  Icon,
  ItemCard,
  KanbanCard,
  KanbanColumn,
  MaterialEditor,
  Menu,
  Meter,
  Modal,
  NavRow,
  PhaseStepper,
  Progress,
  RadioGroup,
  Select,
  Skeleton,
  StatusChip,
  Switch,
  Table,
  Tabs,
  TextField,
  Toast,
  ToastProvider,
  TurnSeparator,
  UserMessage,
} from './index';

/** Isolated preview queue that never consumes app-level notifications. */
const galleryToastQueue = new AriaToastQueue<string>();

/** One labeled specimen block in the component sheet. */
function Specimen({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-ok-lg border border-separator bg-card p-4 shadow-ok-card">
      <h3 className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted">{title}</h3>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

/**
 * Component sheet (board 11) — the A2UI catalog seed (DESIGN.md §9, §11 Tier A).
 *
 * Renders every primitive once so it can be reviewed for fidelity against the
 * applicable design references and previewed under each theme. This is the
 * primitive tier's proof surface mounted at the developer route.
 */
export function Gallery() {
  return (
    <div className="grid grid-cols-2 gap-4">
      <Specimen title="Buttons">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="accent">Approve plan</Button>
          <Button variant="outline">Not now</Button>
          <Button variant="quiet">Reset</Button>
          <Button variant="negative">Reject</Button>
          <Button variant="negative-outline">Skip</Button>
          <Button variant="accent" isDisabled>
            Disabled
          </Button>
          <Button size="sm" variant="outline">
            Small
          </Button>
        </div>
      </Specimen>

      <Specimen title="Status chips">
        <div className="flex flex-wrap gap-2">
          <StatusChip tone="informative" dot>
            Running
          </StatusChip>
          <StatusChip tone="notice">Needs review</StatusChip>
          <StatusChip tone="positive">Approved</StatusChip>
          <StatusChip tone="negative">Failed</StatusChip>
          <StatusChip tone="neutral">Draft</StatusChip>
        </div>
      </Specimen>

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

      <Specimen title="Fields">
        <TextField label="Workspace name" placeholder="Market research" />
        <Select
          label="Model"
          items={[
            { id: 'opus', label: 'Claude Opus 4.8' },
            { id: 'sonnet', label: 'Claude Sonnet 5' },
          ]}
          defaultSelectedKey="opus"
        />
        <Switch defaultSelected>Ask before spending</Switch>
      </Specimen>

      <Specimen title="Overlays + navigation">
        <div className="flex flex-wrap items-center gap-2">
          <Modal trigger={<Button variant="outline">Open dialog</Button>}>
            <Dialog title="Confirm change">
              <p>This modal delegates focus and dismissal to React Aria.</p>
              <Button>Done</Button>
            </Dialog>
          </Modal>
          <Menu
            label="Goal actions"
            items={[
              { id: 'prioritize', label: 'Prioritize' },
              { id: 'pause', label: 'Pause' },
            ]}
            onAction={() => {}}
          />
        </div>
        <Tabs
          aria-label="Goal lens"
          defaultSelectedKey="thread"
          items={[
            { id: 'thread', label: 'Thread', content: 'Thread content' },
            { id: 'plan', label: 'Plan', content: 'Plan content' },
          ]}
        />
      </Specimen>

      <Specimen title="Data + progress">
        <Table
          aria-label="Worker readiness"
          columns={[
            { id: 'worker', label: 'Worker' },
            { id: 'status', label: 'Status' },
          ]}
          rows={[{ id: 'scout', cells: { worker: 'Scout', status: 'Ready' } }]}
        />
        <Progress label="Material upload" minValue={0} maxValue={100} value={60} />
        <Meter label="Workspace storage" minValue={0} maxValue={100} value={65} />
        <RadioGroup
          aria-label="Color theme"
          defaultValue="spectrum"
          items={[
            { id: 'spectrum', label: 'Spectrum' },
            { id: 'paper', label: 'Paper' },
          ]}
        />
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

      <Specimen title="Phase stepper">
        <PhaseStepper current="plan" gate />
        <PhaseStepper current="execute" />
      </Specimen>

      <Specimen title="Nav rows">
        <NavRow icon="home" label="Overview" trailing={<CountBadge count={3} label="need you" />} />
        <NavRow icon="chat" label="Chat" active />
        <NavRow label="Market research" indent={1} icon="folder" />
      </Specimen>

      <Specimen title="Conversation">
        <UserMessage>Draft a competitive teardown of the top three tools.</UserMessage>
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
          kind="notice"
          title="Awaiting plan approval"
          meta="6 steps · 2 need your approval"
          actions={
            <>
              <Button size="sm" variant="accent">
                Approve
              </Button>
              <Button size="sm" variant="outline">
                Request changes
              </Button>
            </>
          }
        />
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

      <Specimen title="Composer">
        <Composer
          chips={
            <>
              <ContextChip>Market research</ContextChip>
              <ContextChip>Goal mode</ContextChip>
              <ContextChip>Opus 4.8</ContextChip>
            </>
          }
        />
      </Specimen>

      <Specimen title="System states">
        <Skeleton lines={3} />
        <EmptyState
          icon="chat"
          title="Nothing here yet"
          hint="Start a chat to begin."
          action={<Button size="sm">New chat</Button>}
        />
        <ErrorBanner message="Couldn't reach the local runtime." onRetry={() => {}} />
      </Specimen>

      <Specimen title="Toast + icons">
        <Toast
          message="Scout finished the teardown."
          onAction={() => {}}
          onDismissAction={() => {}}
        />
        <ToastProvider queue={galleryToastQueue} />
        <div className="flex flex-wrap gap-2 text-fg-muted">
          <Icon name="search" label="Search" />
          <Icon name="settings" label="Settings" />
          <Icon name="agents" label="Agents" />
          <Icon name="generative" label="Generative" />
          <Icon name="disconnected" label="Disconnected" />
        </div>
      </Specimen>
    </div>
  );
}
