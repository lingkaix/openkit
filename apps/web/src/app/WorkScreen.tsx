import { Tabs } from '../primitives';
import { ThreadLists } from './Sidebar';

/** Phone Work tab: Tasks and Goals, one segment at a time. */
export function WorkScreen() {
  return (
    <Tabs
      aria-label="Work"
      className="[&_[role=tab]]:min-h-11 [&_[role=tab]]:px-4"
      items={[
        { id: 'tasks', label: 'Tasks', content: <ThreadLists segment="tasks" /> },
        { id: 'goals', label: 'Goals', content: <ThreadLists segment="goals" /> },
      ]}
    />
  );
}
