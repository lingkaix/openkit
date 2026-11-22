import { useState } from 'react';
import { GenerativeGallery } from '../../generative/GenerativeGallery';
import { Gallery, GallerySideBySide, Switch } from '../../primitives';

/**
 * The full component gallery and the native Generative UI catalog, rendered from
 * fixtures only. Appearance loads this module lazily when "All components" opens.
 * The toolbar options are preview-only: they never change the persisted Appearance
 * choice and reset when the page closes.
 */
export default function AllComponents() {
  const [sideBySide, setSideBySide] = useState(false);
  const [touchScale, setTouchScale] = useState(false);
  return (
    <div className="flex flex-col gap-8">
      <div role="toolbar" aria-label="Gallery preview" className="flex flex-wrap gap-4">
        <Switch isSelected={sideBySide} onChange={setSideBySide}>
          Light and dark side by side
        </Switch>
        <Switch isSelected={touchScale} onChange={setTouchScale}>
          Touch scale
        </Switch>
      </div>
      {/* Touch scale pins the Spectrum mobile sizes on the specimens only; off follows the device. */}
      <div className={`flex flex-col gap-8 ${touchScale ? 'ok-scale-touch' : ''}`}>
        <GallerySideBySide.Provider value={sideBySide}>
          <Gallery />
          <GenerativeGallery />
        </GallerySideBySide.Provider>
      </div>
    </div>
  );
}
