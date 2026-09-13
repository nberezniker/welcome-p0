'use client';

import { useMemo, useState, type KeyboardEvent } from 'react';
import {
  addKeyword,
  filterChips,
  groupChips,
  intentGoal,
  itemsFor,
  labelFor,
  limitFor,
  toggleSelection,
  type PickerAxis,
  type TaxonomyCatalog,
  type UiLocale,
} from '../domain/picker';

/** UI strings — always injected by a server parent (see src/i18n). */
export interface PickerStrings {
  searchPlaceholder: string;
  selected: string;
  limitReached: string;
  noResults: string;
  clear: string;
  remove: string;
  keywordPlaceholder: string;
  keywordTooLong: string;
  unspecified: string;
}

export interface AxisStrings {
  title: string;
  hint: string;
}

/**
 * Chip picker for one taxonomy axis: searchable, grouped (interests), hard-limited
 * (3/3/5 from the catalogue), fully keyboard operable and announced as a group of
 * toggle buttons so screen readers hear the pressed state.
 *
 * Limit rules live in src/domain/picker.ts (unit-tested); this component only
 * renders them.
 */
export function TaxonomyPicker({
  axis,
  catalog,
  locale,
  value,
  onChange,
  strings,
  title,
  hint,
  testId,
  compact = false,
}: {
  axis: PickerAxis;
  catalog: TaxonomyCatalog;
  locale: UiLocale;
  value: string[];
  onChange: (next: string[]) => void;
  strings: PickerStrings;
  title: string;
  hint: string;
  testId?: string;
  /** Denser layout for the directory filter rail. */
  compact?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const limit = limitFor(catalog, axis);
  const groups = useMemo(
    () =>
      axis === 'interests'
        ? groupChips(catalog, locale, query)
        : [{ id: axis, label: '', items: filterChips(itemsFor(catalog, axis, locale), query) }],
    [axis, catalog, locale, query],
  );
  const visibleItems = groups.reduce((n, g) => n + g.items.length, 0);

  const toggle = (id: string) => {
    const result = toggleSelection(value, id, limit);
    if (!result.ok) {
      setNotice(strings.limitReached.replace('{max}', String(limit)));
      return;
    }
    setNotice(null);
    onChange(result.next);
  };

  return (
    <div className={compact ? '' : 'flex flex-col gap-2'} data-testid={testId}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-bold">
          {title}
          <span className="ml-2 text-xs font-semibold text-muted normal-case">
            {strings.selected.replace('{n}', String(value.length)).replace('{max}', String(limit))}
          </span>
        </p>
        {value.length > 0 ? (
          <button
            type="button"
            className="text-xs font-semibold text-muted underline underline-offset-2 hover:text-ink"
            onClick={() => {
              setNotice(null);
              onChange([]);
            }}
          >
            {strings.clear}
          </button>
        ) : null}
      </div>
      <p className="text-xs leading-relaxed text-muted">{hint}</p>

      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((id) => (
            <li key={id}>
              <button
                type="button"
                className="chip"
                onClick={() => toggle(id)}
                aria-label={strings.remove.replace('{label}', itemLabel(catalog, axis, id, locale))}
                data-testid={testId ? `${testId}-selected-${id}` : undefined}
              >
                {itemLabel(catalog, axis, id, locale)}
                <span aria-hidden="true" className="ml-0.5 px-0.5">
                  ×
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <input
        className="input"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={strings.searchPlaceholder}
        aria-label={strings.searchPlaceholder}
        autoComplete="off"
        data-testid={testId ? `${testId}-search` : undefined}
      />

      {notice ? (
        <p className="text-xs font-semibold text-amber-800" role="status" data-testid={testId ? `${testId}-notice` : undefined}>
          {notice}
        </p>
      ) : null}

      {visibleItems === 0 ? (
        <p className="text-xs text-muted">{strings.noResults.replace('{q}', query)}</p>
      ) : (
        <div
          role="group"
          aria-label={title}
          className={compact ? 'flex flex-wrap gap-1.5' : 'flex flex-col gap-2'}
        >
          {groups.map((group) => (
            <div key={group.id}>
              {group.label ? (
                <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-muted">{group.label}</p>
              ) : null}
              <div className="flex flex-wrap gap-1.5">
                {group.items.map((item) => {
                  const selected = value.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={selected ? 'chip !bg-pine !text-white' : 'chip !bg-white !text-ink border border-line'}
                      aria-pressed={selected}
                      onClick={() => toggle(item.id)}
                      data-testid={testId ? `${testId}-${item.id}` : undefined}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Chip text for a stored id — falls back to the raw id for stale values. */
function itemLabel(catalog: TaxonomyCatalog, axis: PickerAxis, id: string, locale: UiLocale): string {
  if (axis === 'interests') {
    const hit = catalog.interests.find((i) => i.id === id);
    return hit ? labelFor(hit.label, locale) : id;
  }
  return intentGoal(catalog, axis === 'need_intents' ? 'need' : 'offer', id, locale);
}

/**
 * Free-form keywords: own words, ≤max entries of ≤maxLength characters. Enter or
 * comma commits, Backspace on an empty field removes the last one.
 */
export function KeywordInput({
  id,
  title,
  hint,
  values,
  onChange,
  strings,
  max,
  maxLength,
  testId,
}: {
  id: string;
  title: string;
  hint: string;
  values: string[];
  onChange: (next: string[]) => void;
  strings: PickerStrings;
  max: number;
  maxLength: number;
  testId?: string;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const commit = (raw: string) => {
    const result = addKeyword(values, raw, max, maxLength);
    if (!result.ok) {
      setError(
        result.reason === 'too_long'
          ? strings.keywordTooLong.replace('{length}', String(maxLength))
          : strings.limitReached.replace('{max}', String(max)),
      );
      return;
    }
    setError(null);
    setDraft('');
    onChange(result.next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div data-testid={testId}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label className="text-sm font-bold" htmlFor={id}>
          {title}
          <span className="ml-2 text-xs font-semibold text-muted normal-case">
            {strings.selected.replace('{n}', String(values.length)).replace('{max}', String(max))}
          </span>
        </label>
      </div>
      <p className="mt-0.5 text-xs leading-relaxed text-muted">{hint}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-[#ccd3c6] bg-white p-2">
        {values.map((keyword) => (
          <span key={keyword} className="chip">
            {keyword}
            <button
              type="button"
              className="ml-0.5 rounded-full px-1 text-pine/70 hover:text-accent"
              aria-label={strings.remove.replace('{label}', keyword)}
              onClick={() => onChange(values.filter((x) => x !== keyword))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={id}
          className="min-w-[8rem] flex-1 bg-transparent px-1 py-1 text-sm outline-none"
          value={draft}
          maxLength={maxLength}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => draft && commit(draft)}
          placeholder={values.length === 0 ? strings.keywordPlaceholder : ''}
          autoComplete="off"
          aria-describedby={`${id}-hint`}
          data-testid={testId ? `${testId}-input` : undefined}
        />
      </div>
      <p id={`${id}-hint`} className="sr-only">
        {hint}
      </p>
      {error ? (
        <p className="mt-1 text-xs font-semibold text-amber-800" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Single-select facet (function / industry) with an explicit "not specified". */
export function FacetSelect({
  id,
  title,
  hint,
  catalog,
  locale,
  kind,
  value,
  onChange,
  strings,
  testId,
}: {
  id: string;
  title: string;
  hint: string;
  catalog: TaxonomyCatalog;
  locale: UiLocale;
  kind: 'functions' | 'industries';
  value: string | null;
  onChange: (next: string | null) => void;
  strings: PickerStrings;
  testId?: string;
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {title}
      </label>
      <p className="mb-1.5 text-xs text-muted">{hint}</p>
      <select
        id={id}
        className="input"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        data-testid={testId}
      >
        <option value="">{strings.unspecified}</option>
        {catalog[kind].map((facet) => (
          <option key={facet.id} value={facet.id}>
            {labelFor(facet.label, locale)}
          </option>
        ))}
      </select>
    </div>
  );
}
