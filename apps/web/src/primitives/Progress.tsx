import {
  Meter as AriaMeter,
  type MeterProps as AriaMeterProps,
  ProgressBar as AriaProgressBar,
  type ProgressBarProps as AriaProgressBarProps,
} from 'react-aria-components';

/** Properties for the OpenKit determinate progress bar. */
export interface ProgressProps
  extends Pick<AriaProgressBarProps, 'minValue' | 'maxValue' | 'value'> {
  /** Visible and accessible operation label. */
  label: string;
}

/** OpenKit determinate progress bar backed by React Aria range semantics. */
export function Progress({ label, minValue, maxValue, value }: ProgressProps) {
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
          <span className="flex justify-between gap-2 text-xs font-bold text-fg">
            <span>{label}</span>
            <span>{valueText}</span>
          </span>
          <span className="h-2 overflow-hidden rounded-full bg-sunken">
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
}

/** OpenKit meter backed by React Aria range semantics. */
export function Meter({ label, minValue, maxValue, value }: MeterProps) {
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
          <span className="flex justify-between gap-2 text-xs font-bold text-fg">
            <span>{label}</span>
            <span>{valueText}</span>
          </span>
          <span className="h-2 overflow-hidden rounded-full bg-sunken">
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
