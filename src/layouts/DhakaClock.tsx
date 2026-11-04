import { useEffect, useState } from 'react';

/**
 * Live Asia/Dhaka date + time for the header utility bar.
 *
 * The Learning Hub header carries its E-BOOK link and BN|EN switcher in
 * the utility bar; LeadFlow carries this clock in the same slot
 * (Mahadi's spec, 2026-11-04). The formatters are pinned to
 * `Asia/Dhaka`, so the reading is correct on any viewer's device
 * regardless of the device's own timezone.
 *
 * Shape: `Wednesday, 4 November 2026 · 11:59:24 AM` — long weekday and
 * month from en-GB, 12-hour time with seconds from en-US (which keeps
 * the AM/PM marker upper-case). The clock ticks every second and the
 * interval is always cleared on unmount.
 */

const DHAKA_TIME_ZONE = 'Asia/Dhaka';

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: DHAKA_TIME_ZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: DHAKA_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

/** Format one instant as the utility-bar date + time line (Dhaka). */
export function formatDhakaDateTime(instant: Date): string {
  return `${dateFormatter.format(instant)} · ${timeFormatter.format(instant)}`;
}

/**
 * Subscribe to a ticking clock: `onTick` receives the current instant
 * every `intervalMs`. Returns the unsubscribe function, which clears
 * the interval — the hook below wires it to the effect cleanup.
 */
export function subscribeDhakaClock(
  onTick: (now: Date) => void,
  intervalMs = 1000,
): () => void {
  const id = setInterval(() => onTick(new Date()), intervalMs);
  return () => clearInterval(id);
}

/** React hook form of {@link subscribeDhakaClock}: re-renders each tick. */
export function useDhakaNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => subscribeDhakaClock(setNow, intervalMs), [intervalMs]);
  return now;
}

export default function DhakaClock({ className }: { className?: string }) {
  const now = useDhakaNow(1000);
  return (
    <time
      dateTime={now.toISOString()}
      className={className}
      aria-label="Current date and time in Dhaka"
    >
      {formatDhakaDateTime(now)}
    </time>
  );
}
