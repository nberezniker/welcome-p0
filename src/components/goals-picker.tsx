'use client';

import { useState } from 'react';
import { GOALS, MAX_GOALS, type GoalId } from '../domain/goals';
import type { UiLocale } from '../domain/picker';

/**
 * Goal picker (matching v4 §B2): the 16-goal catalogue as toggle chips, at most
 * three, in the user's own priority order.
 *
 * Two product rules are structural here rather than copy:
 *
 *   - the ORDER is the priority, so a re-click removes a goal instead of moving
 *     it, and the selected chip shows its rank (1/2/3);
 *   - the limit is enforced before the state update, so a fourth goal can never
 *     be latent in the form and rejected later by the API.
 *
 * The catalogue is imported from the domain (single source, three locales
 * included) — this component never invents a label.
 */
export function GoalsPicker({
  value,
  onChange,
  locale,
  strings,
  testId = 'goals-picker',
}: {
  value: readonly string[];
  onChange: (next: GoalId[]) => void;
  locale: UiLocale;
  strings: { title: string; hint: string; limit: string; counter: string; clear: string };
  testId?: string;
}) {
  const [limitHit, setLimitHit] = useState(false);
  const selected = value.filter((id): id is GoalId => GOALS.some((g) => g.id === id));

  const toggle = (id: GoalId) => {
    if (selected.includes(id)) {
      setLimitHit(false);
      onChange(selected.filter((x) => x !== id));
      return;
    }
    if (selected.length >= MAX_GOALS) {
      setLimitHit(true);
      return;
    }
    setLimitHit(false);
    onChange([...selected, id]);
  };

  return (
    <section className="card" data-testid={testId}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold tracking-tight">{strings.title}</h2>
        <span className="text-xs text-muted" data-testid={`${testId}-counter`}>
          {strings.counter}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted">{strings.hint}</p>

      <ul className="mt-3 flex flex-wrap gap-2">
        {GOALS.map((goal) => {
          const rank = selected.indexOf(goal.id);
          const active = rank >= 0;
          return (
            <li key={goal.id}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => toggle(goal.id)}
                className={active ? 'chip-offer' : 'chip !bg-white !text-ink border border-line'}
                data-testid={`goal-${goal.id}`}
              >
                {active ? `${rank + 1}. ` : ''}
                {goal.label[locale]}
              </button>
            </li>
          );
        })}
      </ul>

      {limitHit ? (
        <p className="mt-2 text-xs text-amber-900" role="status" data-testid={`${testId}-limit`}>
          {strings.limit}
        </p>
      ) : null}

      {selected.length > 0 ? (
        <button
          type="button"
          className="btn-light btn-small mt-3"
          onClick={() => {
            setLimitHit(false);
            onChange([]);
          }}
          data-testid={`${testId}-clear`}
        >
          {strings.clear}
        </button>
      ) : null}
    </section>
  );
}
