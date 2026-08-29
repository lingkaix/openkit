import { Outlet } from 'react-router-dom';
import { ToastProvider } from '../primitives';
import { AppSearch } from '../screens/operations';
import { DisconnectedBanner } from './DisconnectedBanner';
import { Sidebar } from './Sidebar';
import { THEME_CLASS, useThemeStore } from './theme-store';

/**
 * App shell (DESIGN.md §3): two persistent regions plus one optional auxiliary.
 *
 * Left sidebar (264px) · centered main column (the routed surface). The optional
 * auxiliary rail is never a required region and never a decorative empty strip
 * (§3.3, Principle 8), so a surface that has an index renders its own rail (e.g.
 * the chat thread's artifacts rail) rather than the shell reserving dead space.
 * The active theme class scopes the whole shell so every semantic utility retints
 * at once (§4.6). The shell holds its structure down to the 800×600 workbench
 * floor (§3.4, §12) with no horizontal body overflow — wide content scrolls
 * inside its own region. The global disconnected banner sits above the work area
 * (§9.12).
 */
export function AppShell() {
  const theme = useThemeStore((s) => s.theme);
  return (
    <div
      className={`${THEME_CLASS[theme]} flex h-full min-h-[600px] min-w-[800px] bg-canvas text-fg`}
    >
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <DisconnectedBanner />
        <AppSearch />
        <main aria-label="Workspace" className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <ToastProvider />
    </div>
  );
}
