import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TimelineScroll } from '../src/screens/chat/timeline/TimelineScroll';

declare global {
  interface Window {
    growAbove(): void;
  }
}
function Fixture() {
  const [height, setHeight] = useState(500);
  window.growAbove = () => setHeight(637);
  return (
    <div data-timeline-lens="work">
      <div data-timeline-scroll style={{ height: 300, width: 340, overflow: 'auto' }}>
        <TimelineScroll
          topEntryId="visible-run"
          initiallyFollowing={false}
          canEarlier={false}
          canLater={false}
          paging={false}
          onEarlier={() => {}}
          onLater={() => {}}
          showJump={false}
          onJump={() => {}}
          newCount={0}
          decisionNew={false}
          onFollowChange={() => {}}
          onCatchUp={() => {}}
        >
          <article data-timeline-entry="visible-run">
            <div data-growth-prefix style={{ height }} />
            {Array.from({ length: 120 }, (_, i) => String(i).padStart(3, '0')).map((line) => (
              <p key={line} style={{ margin: 0, height: 20, lineHeight: '20px' }}>
                Reading point {line} retained text
              </p>
            ))}
          </article>
        </TimelineScroll>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
