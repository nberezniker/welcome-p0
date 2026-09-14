import {
  ANALYTICS_WINDOW_DAYS,
  funnelSteps,
  type EventAnalytics,
  type FunnelStepKey,
} from '../../../../domain/event-analytics';

/**
 * Organizer funnel (spec S08): the chain registration → activation → directory →
 * intros → mutual with the share of the previous step, the wider outcome counts,
 * and a 30-day activity chart drawn as inline SVG (no chart library — the CSP
 * forbids remote scripts and the payload is three small series).
 *
 * Server component: the numbers come from `loadEventAnalytics`, the same call the
 * JSON endpoint serves, so the page and `/api/organizer/events/[id]/analytics`
 * can never disagree. Aggregates only — there is nothing private to leak.
 */

export interface FunnelStrings {
  title: string;
  steps: Record<FunnelStepKey, string>;
  conversion: string;
  claimed: string;
  declined: string;
  reveals: string;
  notes: string;
  attendance: string;
  outcomesTitle: string;
  byDayTitle: string;
  legendRegistrations: string;
  legendIntros: string;
  legendMutual: string;
  chartAlt: string;
  noData: string;
  hint: string;
}

const CHART = { width: 320, height: 72, days: ANALYTICS_WINDOW_DAYS } as const;

const SERIES = [
  { key: 'registrations', stroke: 'var(--color-pine)' },
  { key: 'intros', stroke: 'var(--color-accent)' },
  { key: 'mutual', stroke: 'var(--color-muted)' },
] as const;

/** Polyline points for one series, scaled to the shared max. */
function points(values: number[], max: number): string {
  const span = Math.max(1, values.length - 1);
  return values
    .map((value, index) => {
      const x = (index / span) * CHART.width;
      const y = max <= 0 ? CHART.height : CHART.height - (value / max) * CHART.height;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function FunnelPanel({ analytics, strings }: { analytics: EventAnalytics; strings: FunnelStrings }) {
  const steps = funnelSteps(analytics);
  const outcomes: { key: string; label: string; value: number }[] = [
    { key: 'claimed', label: strings.claimed, value: analytics.registrations_claimed },
    { key: 'declined', label: strings.declined, value: analytics.intros_declined },
    { key: 'reveals', label: strings.reveals, value: analytics.reveals_total },
    { key: 'notes', label: strings.notes, value: analytics.notes_created },
    { key: 'attendance', label: strings.attendance, value: analytics.attendance_self_reported },
  ];

  const byDay = analytics.by_day;
  const max = byDay.reduce(
    (acc, d) => Math.max(acc, d.registrations, d.intros, d.mutual),
    0,
  );
  const hasActivity = max > 0;
  const firstDate = byDay[0]?.date ?? '';
  const lastDate = byDay[byDay.length - 1]?.date ?? '';

  return (
    <section className="card mt-6" aria-labelledby="funnel-heading">
      <h2 id="funnel-heading" className="eyebrow">
        {strings.title}
      </h2>

      {/* Chain with step-to-step conversion */}
      <ol className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="funnel">
        {steps.map((step) => (
          <li key={step.key} className="rounded-xl border border-line bg-paper px-3 py-2.5" data-testid={`funnel-step-${step.key}`}>
            <b className="block text-2xl leading-tight tabular-nums" data-testid={`funnel-value-${step.key}`}>
              {step.value}
            </b>
            <span className="text-[11px] text-muted">{strings.steps[step.key]}</span>
            {step.shareOfPrevious !== null ? (
              <span className="mt-1 block text-[11px] font-semibold text-ink" data-testid={`funnel-share-${step.key}`}>
                {`${step.shareOfPrevious}%`}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-muted">{strings.conversion}</p>

      {/* Wider outcomes */}
      <h3 className="mt-5 text-sm font-bold tracking-tight">{strings.outcomesTitle}</h3>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="funnel-outcomes">
        {outcomes.map((item) => (
          <div key={item.key} className="rounded-xl border border-line px-3 py-2" data-testid={`funnel-metric-${item.key}`}>
            <b className="block text-lg leading-tight tabular-nums">{item.value}</b>
            <span className="text-[11px] text-muted">{item.label}</span>
          </div>
        ))}
      </div>

      {/* 30-day activity */}
      <h3 className="mt-5 text-sm font-bold tracking-tight">{strings.byDayTitle}</h3>
      {hasActivity ? (
        <>
          <svg
            className="mt-2 w-full"
            viewBox={`0 0 ${CHART.width} ${CHART.height}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={strings.chartAlt}
            data-testid="funnel-chart"
            height={CHART.height}
          >
            <line x1="0" y1={CHART.height} x2={CHART.width} y2={CHART.height} stroke="var(--color-line)" strokeWidth="1" />
            {SERIES.map((series) => (
              <path
                key={series.key}
                d={points(byDay.map((d) => d[series.key]), max)}
                fill="none"
                stroke={series.stroke}
                strokeWidth="1.5"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
          </svg>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted">
            <span className="tabular-nums">{firstDate}</span>
            <span className="tabular-nums">{lastDate}</span>
            <span className="inline-flex items-center gap-1">
              <span aria-hidden className="inline-block h-1.5 w-3 rounded-full" style={{ background: 'var(--color-pine)' }} />
              {strings.legendRegistrations}
            </span>
            <span className="inline-flex items-center gap-1">
              <span aria-hidden className="inline-block h-1.5 w-3 rounded-full" style={{ background: 'var(--color-accent)' }} />
              {strings.legendIntros}
            </span>
            <span className="inline-flex items-center gap-1">
              <span aria-hidden className="inline-block h-1.5 w-3 rounded-full" style={{ background: 'var(--color-muted)' }} />
              {strings.legendMutual}
            </span>
          </div>
        </>
      ) : (
        <p className="mt-2 text-sm text-muted" data-testid="funnel-chart-empty">
          {strings.noData}
        </p>
      )}

      <p className="mt-3 text-xs text-muted">{strings.hint}</p>
    </section>
  );
}
