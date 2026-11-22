import {
  Meter as AriaMeter,
  type MeterProps as AriaMeterProps,
  ProgressBar as AriaProgressBar,
  type ProgressBarProps as AriaProgressBarProps,
} from 'react-aria-components';

/** S2 bar sizes: M (default) is 6px desktop / 8px touch, S is 4px / 5px. */
export type BarSize = 'S' | 'M';

/** Properties for the OpenKit determinate progress bar. */
export interface ProgressProps
  extends Pick<AriaProgressBarProps, 'minValue' | 'maxValue' | 'value'> {
  /** Visible and accessible operation label. */
  label: string;
  /** Track thickness. Defaults to M. */
  size?: BarSize;
}

/** Label row shared by Progress and Meter: 12px label and value, regular weight. */
function BarLabel({ label, valueText }: { label: string; valueText?: string }) {
  return (
    <span className="flex justify-between gap-2 text-xs text-fg">
      <span>{label}</span>
      <span className="text-fg-muted">{valueText}</span>
    </span>
  );
}

/**
 * OpenKit determinate progress bar (DESIGN.md §9.6): S2 ProgressBar, label and value over
 * a rounded track, accent fill. React Aria owns the range semantics.
 */
export function Progress({ label, minValue, maxValue, value, size = 'M' }: ProgressProps) {
  return (
    <AriaProgressBar
      aria-label={label}
      minValue={minValue}
      maxValue={maxValue}
      value={value}
      className="flex flex-col gap-1"
    >
      {({ percentage, valueText }) => (
        <>
          <BarLabel label={label} valueText={valueText} />
          <span
            className={`ok-progress-track overflow-hidden rounded-full bg-sunken ${size === 'S' ? 'ok-progress-sm' : ''}`}
          >
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${percentage ?? 0}%` }}
            />
          </span>
        </>
      )}
    </AriaProgressBar>
  );
}

/** Properties for the OpenKit meter. */
export interface MeterProps extends Pick<AriaMeterProps, 'minValue' | 'maxValue' | 'value'> {
  /** Visible and accessible quantity label. */
  label: string;
  /** Track thickness. Defaults to M. */
  size?: BarSize;
}

/** OpenKit meter (S2 Meter, same look as Progress with a positive fill). */
export function Meter({ label, minValue, maxValue, value, size = 'M' }: MeterProps) {
  return (
    <AriaMeter
      aria-label={label}
      minValue={minValue}
      maxValue={maxValue}
      value={value}
      className="flex flex-col gap-1"
    >
      {({ percentage, valueText }) => (
        <>
          <BarLabel label={label} valueText={valueText} />
          <span
            className={`ok-meter-track overflow-hidden rounded-full bg-sunken ${size === 'S' ? 'ok-progress-sm' : ''}`}
          >
            <span
              className="block h-full rounded-full bg-positive-fg"
              style={{ width: `${percentage}%` }}
            />
          </span>
        </>
      )}
    </AriaMeter>
  );
}
