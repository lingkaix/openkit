import { Link } from 'react-router-dom';
import { Card, Page, PageHeader } from '../../primitives';
import { AdministratorCleanupPanel } from './AdministratorCleanupPanel';
import { ServerHealthPanel } from './ServerHealthPanel';

const MAINTENANCE = [
  {
    path: '/settings/configuration',
    title: 'Configuration and Policy',
    hint: 'Inspect the authored configuration and apply supported reloads. Policy decisions remain in Server audit.',
  },
  {
    path: '/settings/ai-interface',
    title: 'Gateway',
    hint: 'Inspect Providers, accounts, models and logical routes.',
  },
  {
    path: '/settings/vault-admin',
    title: 'Vault backend and secrets',
    hint: 'Inspect backend state and manage secrets for the selected Workspace.',
  },
  {
    path: '/settings/server-audit',
    title: 'Server audit',
    hint: 'Inspect recorded server events and permission decisions.',
  },
  {
    path: '/settings/app-update',
    title: 'App update',
    hint: 'Prepare an exact published release and inspect its update receipt.',
  },
  {
    path: '/settings/administration',
    title: 'Administration',
    hint: 'Prepare a technical change or inspect retained Worker environments before deletion.',
  },
  {
    path: '/settings/workspace-access-recovery',
    title: 'Workspace access recovery',
    hint: 'Inspect current ownership and explicitly recover access under administrator authority.',
  },
  {
    path: '/settings/data-root-backup',
    title: 'Deployment data-root backup',
    hint: 'Create or verify the supported data-root backup. This does not provide whole-server recovery.',
  },
  {
    path: '/settings/portability',
    title: 'Portability',
    hint: 'Export or import the supported User and Workspace data.',
  },
] as const;

/** Deployment observations and supported maintenance destinations, separate from Workspace settings. */
export function ServerOperationsScreen() {
  return (
    <Page>
      <PageHeader
        eyebrow="Administration"
        title="Server operations"
        subtitle="Inspect current server observations and open the supported maintenance controls. Each operation checks your current authority."
      />
      <ServerHealthPanel />
      <AdministratorCleanupPanel />
      <section className="flex flex-col gap-3" aria-labelledby="server-maintenance">
        <h2 id="server-maintenance" className="text-lg font-extrabold text-fg-strong">
          Maintenance and recovery
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          {MAINTENANCE.map((destination) => (
            <Card key={destination.path} className="flex flex-col gap-2">
              <Link
                to={destination.path}
                className="text-sm font-bold text-accent hover:underline focus-visible:outline focus-visible:outline-focus"
              >
                {destination.title}
              </Link>
              <p className="text-sm text-fg-muted">{destination.hint}</p>
            </Card>
          ))}
        </div>
      </section>
    </Page>
  );
}
