'use client';

import { useState, type KeyboardEvent } from 'react';

/**
 * Chip tag input: Enter or comma adds a chip, Backspace on empty input removes
 * the last one, × removes a specific chip. Max 30 chips (API limit).
 */
export function TagInput({
  id,
  label,
  hint,
  values,
  onChange,
  placeholder,
  max = 30,
  ariaDescribedBy,
}: {
  id: string;
  label: string;
  hint?: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  max?: number;
  ariaDescribedBy?: string;
}) {
  const [draft, setDraft] = useState('');

  const add = (raw: string) => {
    const v = raw.trim().toLowerCase().replace(/,+$/, '');
    if (!v || values.includes(v) || values.length >= max) return;
    onChange([...values, v]);
    setDraft('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {hint ? (
        <p id={ariaDescribedBy} className="mb-1.5 text-xs text-muted">
          {hint}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[#ccd3c6] bg-white p-2">
        {values.map((tag) => (
          <span key={tag} className="chip" data-testid={`chip-${id}`}>
            {tag}
            <button
              type="button"
              className="ml-0.5 rounded-full px-1 text-pine/70 hover:text-accent"
              aria-label={`Remove ${tag}`}
              onClick={() => onChange(values.filter((x) => x !== tag))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={id}
          className="min-w-[8rem] flex-1 bg-transparent px-1 py-1 text-sm outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => draft && add(draft)}
          placeholder={values.length === 0 ? placeholder : ''}
          aria-describedby={ariaDescribedBy}
          autoComplete="off"
        />
      </div>
    </div>
  );
}
