/**
 * perf.ts — lightweight performance instrumentation for critical API paths.
 * ------------------------------------------------------------------
 * - Emits a `Server-Timing` response header (visible in browser DevTools →
 *   Network) so regressions are measurable without changing response bodies.
 * - Emits ONE structured console line per instrumented request when
 *   development logging is enabled:
 *       [perf] {"event":"lead.create","totalMs":87.4,"spans":[...]}
 *   Enabled outside production (NODE_ENV !== 'production' and not Vercel),
 *   or anywhere with an explicit PERF_LOGS=1. Production stays quiet by
 *   default — only the header is emitted.
 * - Never logs request bodies, credentials, tokens, SQL text or customer
 *   data: only span labels and durations.
 */

export interface PerfSpan {
  label: string;
  ms: number;
}

export interface Perf {
  /** Records the elapsed time since the previous span point (or start). */
  span(label: string): void;
  /** Elapsed time since the tracker was created, in ms. */
  totalMs(): number;
  /**
   * Sets the Server-Timing header on the response and (when enabled) logs
   * the structured timing line. Call before the response body is sent.
   */
  finish(res: any): number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

function nowMs(): number {
  // `performance.now()` is a monotonic clock — no wall-clock jumps.
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function loggingEnabled(): boolean {
  if (process.env.PERF_LOGS === '1') return true;
  return process.env.NODE_ENV !== 'production' && !process.env.VERCEL;
}

export function createPerf(event: string): Perf {
  const startedAt = nowMs();
  let lastAt = startedAt;
  const spans: PerfSpan[] = [];

  return {
    span(label: string): void {
      const t = nowMs();
      spans.push({ label, ms: round1(t - lastAt) });
      lastAt = t;
    },
    totalMs(): number {
      return round1(nowMs() - startedAt);
    },
    finish(res: any): number {
      const total = round1(nowMs() - startedAt);
      try {
        if (res && typeof res.setHeader === 'function') {
          const parts = [`total;dur=${total}`];
          for (const s of spans) parts.push(`${s.label};dur=${s.ms}`);
          res.setHeader('Server-Timing', parts.join(', '));
        }
      } catch {
        // A timing header must never break the response.
      }
      if (loggingEnabled()) {
        try {
          console.info('[perf]', JSON.stringify({ event, totalMs: total, spans }));
        } catch {
          // Logging must never break the response.
        }
      }
      return total;
    },
  };
}
