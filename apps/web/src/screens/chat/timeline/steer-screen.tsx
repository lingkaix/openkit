import type { ReactNode } from 'react';
import { ThreadScreen } from '../ThreadScreen';
import { SteerProvider } from './steer-context';

/** Thread screen plus steer state. The screen file itself stays with the other lane. */
export function SteerThreadScreen({ mode }: { mode: 'chat' | 'task' }): ReactNode {
  return (
    <SteerProvider mode={mode}>
      <ThreadScreen mode={mode} />
    </SteerProvider>
  );
}
