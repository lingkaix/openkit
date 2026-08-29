import {
  Button,
  Card,
  Eyebrow,
  Icon,
  ListRow,
  Page,
  PageHeader,
  Select,
  StatusChip,
  Switch,
  TextField,
} from '../../primitives';
import { type AutomationRow, useAutomations } from './data';

/**
 * Automations surface (WP-8, board 09).
 *
 * Non-executing facade: scheduled work list beside a create panel.
 * Data comes from `useAutomations()` sample fixtures while unpublished.
 * The app route is omitted until the automation contract stabilizes.
 */
export function AutomationsScreen() {
  const { data: automations } = useAutomations();

  return (
    <Page className="max-w-none lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-5">
        <PageHeader
          title="Automations"
          subtitle="Work that runs on a schedule, always reviewed before it ships."
        />
        <Card className="p-0 px-4">
          {automations.map((row) => (
            <AutomationListRow key={row.id} row={row} />
          ))}
        </Card>
      </div>

      <aside className="w-full shrink-0 lg:w-[360px]">
        <Card className="flex flex-col gap-3.5">
          <Eyebrow>New automation</Eyebrow>
          <TextField label="Name" defaultValue="Weekly pricing refresh" />
          <TextField
            label="What should happen"
            defaultValue="Check the five competitor pricing pages and update the comparison table."
          />
          <Select
            label="Workspace"
            items={[
              { id: 'ws_market', label: 'Market research' },
              { id: 'ws_ops', label: 'Ops & finance' },
            ]}
            defaultSelectedKey="ws_market"
            placeholder="Market research"
          />
          <Select
            label="Schedule"
            items={[
              { id: 'mon9', label: 'Every Monday · 9:00' },
              { id: 'weekday730', label: 'Every weekday · 7:30' },
            ]}
            defaultSelectedKey="mon9"
            placeholder="Every Monday · 9:00"
          />
          <Switch defaultSelected>Ask me before sharing results</Switch>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="quiet" size="sm">
              Cancel
            </Button>
            <Button size="sm">Create automation</Button>
          </div>
        </Card>
      </aside>
    </Page>
  );
}

/**
 * One automation list row.
 *
 * @param props Row data.
 */
function AutomationListRow({ row }: { row: AutomationRow }) {
  return (
    <ListRow>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-fg-strong">{row.name}</p>
        <p className="truncate text-xs text-fg-muted">{row.description}</p>
      </div>
      <div className="hidden w-40 shrink-0 flex-col gap-0.5 text-xs text-fg-muted sm:flex">
        <span className="inline-flex items-center gap-1.5">
          <Icon name="automations" size="sm" />
          {row.schedule}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Icon name="folder" size="sm" />
          {row.workspace}
        </span>
      </div>
      <StatusChip tone={row.statusTone} dot>
        {row.statusLabel}
      </StatusChip>
      <Button variant="quiet" size="sm" aria-label={`More actions for ${row.name}`}>
        <Icon name="more" />
      </Button>
    </ListRow>
  );
}
