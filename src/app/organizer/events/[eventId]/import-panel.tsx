'use client';

import { useState } from 'react';
import { fill } from '../../../../components/fill';
import { IMPORT_FIELDS, type ImportField } from '../../../../domain/import';

/** Sentinel for "leave this column out of the import". */
const IGNORE = '';

interface PreviewData {
  totalRows: number;
  validEmails: number;
  invalidEmails: number;
  quarantined: number;
  duplicatesInFile: number;
  sample: Record<string, unknown>[];
}

interface PreviewResponse {
  mapping: Record<string, string | null>;
  columns: string[];
  would_insert: number;
  would_update: number;
  quarantined_count: number;
  errors: string[];
  preview: PreviewData;
}

interface CommitCounts {
  created: number;
  updated: number;
  skipped: number;
  quarantined: number;
}

type Strings = {
  importTitle: string;
  importHint: string;
  importFile: string;
  importPreview: string;
  importCommit: string;
  importing: string;
  previewTitle: string;
  previewTotalTemplate: string;
  previewValidTemplate: string;
  previewInvalidTemplate: string;
  previewQuarantinedTemplate: string;
  previewDuplicatesTemplate: string;
  commitCountsTemplate: string;
  importErrors: string;
  errorGeneric: string;
  errorNetwork: string;
  // Column mapping
  importMapTitle: string;
  importMapHint: string;
  importMapColumn: string;
  importMapField: string;
  importMapIgnore: string;
  importMapRecalc: string;
  importWouldInsertTemplate: string;
  importWouldUpdateTemplate: string;
  importWouldQuarantineTemplate: string;
  importFieldLabels: Record<ImportField, string>;
  importMapErrorUnknownField: string;
  importMapErrorUnknownColumn: string;
  importMapErrorDuplicate: string;
  importMapErrorInvalid: string;
};

/** Field → the selected CSV column, inverted from the selects' state. */
type Selection = Record<string, ImportField | typeof IGNORE>;

function selectionFromResponse(response: PreviewResponse): Selection {
  const selection: Selection = {};
  for (const column of response.columns) selection[column] = IGNORE;
  for (const field of IMPORT_FIELDS) {
    const column = response.mapping[field];
    if (column && column in selection) selection[column] = field;
  }
  return selection;
}

/** Only non-ignored columns are sent; the server validates each pairing. */
function mappingFromSelection(selection: Selection): Record<string, ImportField> {
  const mapping: Record<string, ImportField> = {};
  for (const [column, field] of Object.entries(selection)) {
    if (field !== IGNORE) mapping[column] = field;
  }
  return mapping;
}

/** CSV import UI: file → preview (mapped columns, quarantined, errors) → commit. */
export function ImportPanel({ eventId, strings }: { eventId: string; strings: Strings }) {
  const [file, setFile] = useState<File | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [response, setResponse] = useState<PreviewResponse | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [counts, setCounts] = useState<CommitCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errorForCode = (code: string | undefined): string => {
    switch (code) {
      case 'unknown_mapping_field':
        return strings.importMapErrorUnknownField;
      case 'unknown_csv_column':
        return strings.importMapErrorUnknownColumn;
      case 'duplicate_mapping_field':
        return strings.importMapErrorDuplicate;
      case 'invalid_mapping':
        return strings.importMapErrorInvalid;
      default:
        return strings.errorGeneric;
    }
  };

  const send = async (mode: 'preview' | 'commit', textOverride?: string, selectionOverride?: Selection) => {
    const text = textOverride ?? csvText;
    if (!text) return;
    const active = selectionOverride ?? selection;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { csv_text: text, mode };
      if (active) body.mapping = mappingFromSelection(active);
      const res = await fetch(`/api/events/${eventId}/imports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => null)) as
        | (Partial<PreviewResponse> & { counts?: CommitCounts; errors?: string[]; code?: string; message?: string })
        | null;
      if (res.ok) {
        if (mode === 'preview' && payload?.preview && payload.columns) {
          const next = payload as PreviewResponse;
          setResponse(next);
          setSelection(selectionFromResponse(next));
          setCounts(null);
        } else if (mode === 'commit' && payload?.counts) {
          setCounts(payload.counts);
          setResponse(null);
          setSelection(null);
          setCsvText(null);
        }
        setErrors(payload?.errors ?? []);
      } else {
        setError(res.status === 400 && payload?.code ? errorForCode(payload.code) : (payload?.message ?? strings.errorGeneric));
      }
    } catch {
      setError(strings.errorNetwork);
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async (next: File | null) => {
    setFile(next);
    setResponse(null);
    setSelection(null);
    setCounts(null);
    setErrors([]);
    setError(null);
    if (!next) {
      setCsvText(null);
      return;
    }
    // The file is read once and kept in memory: every recalculation re-sends the
    // same bytes, so the preview the organizer approves is the one that commits.
    const text = await next.text();
    setCsvText(text);
    await send('preview', text, undefined);
  };

  return (
    <section className="card mt-6" aria-label={strings.importTitle}>
      <h2 className="text-lg font-bold tracking-tight">{strings.importTitle}</h2>
      <p className="mt-1 text-xs text-muted">{strings.importHint}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="label mb-0" htmlFor="import-file">
          {strings.importFile}
        </label>
        <input
          id="import-file"
          type="file"
          accept=".csv,text/csv"
          className="text-sm"
          onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
          data-testid="import-file"
        />
        <button
          type="button"
          className="btn-light btn-small"
          disabled={!file || busy}
          onClick={() => void send('preview')}
          data-testid="import-preview"
        >
          {strings.importPreview}
        </button>
        {response ? (
          <button
            type="button"
            className="btn-primary btn-small"
            disabled={busy}
            onClick={() => void send('commit')}
            data-testid="import-commit"
          >
            {busy ? strings.importing : strings.importCommit}
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="mt-2 text-sm text-red-700" role="alert" data-testid="import-error">
          {error}
        </p>
      ) : null}

      {/* Column mapping: which CSV column feeds which field. */}
      {response && selection ? (
        <div className="mt-4 rounded-lg border border-line bg-paper p-3" data-testid="import-map-panel">
          <p className="text-sm font-bold">{strings.importMapTitle}</p>
          <p className="mt-0.5 text-xs text-muted">{strings.importMapHint}</p>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {response.columns.map((column, i) => (
              <li key={`${column}-${i}`} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={column}>
                  {column}
                </span>
                <label className="sr-only" htmlFor={`import-map-select-${i}`}>
                  {strings.importMapField}
                </label>
                <select
                  id={`import-map-select-${i}`}
                  className="input w-40 py-1 text-xs"
                  value={selection[column] ?? IGNORE}
                  onChange={(e) => {
                    const value = e.target.value as ImportField | typeof IGNORE;
                    setSelection((prev) => (prev ? { ...prev, [column]: value } : prev));
                  }}
                  data-testid={`import-map-${i}`}
                  data-column={column}
                >
                  <option value={IGNORE}>{strings.importMapIgnore}</option>
                  {IMPORT_FIELDS.map((field) => (
                    <option key={field} value={field}>
                      {strings.importFieldLabels[field]}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn-light btn-small mt-3"
            disabled={busy}
            onClick={() => void send('preview')}
            data-testid="import-map-recalc"
          >
            {strings.importMapRecalc}
          </button>
        </div>
      ) : null}

      {response ? (
        <div className="mt-4" data-testid="import-preview-panel">
          <p className="text-sm font-bold">{strings.previewTitle}</p>
          {/* The numbers the organizer decides on: what commit will do. */}
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold" data-testid="import-map-counts">
            <li>{fill(strings.importWouldInsertTemplate, { n: response.would_insert })}</li>
            <li>{fill(strings.importWouldUpdateTemplate, { n: response.would_update })}</li>
            <li>{fill(strings.importWouldQuarantineTemplate, { n: response.quarantined_count })}</li>
          </ul>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <li>{fill(strings.previewTotalTemplate, { n: response.preview.totalRows })}</li>
            <li>{fill(strings.previewValidTemplate, { n: response.preview.validEmails })}</li>
            <li>{fill(strings.previewInvalidTemplate, { n: response.preview.invalidEmails })}</li>
            <li>{fill(strings.previewQuarantinedTemplate, { n: response.preview.quarantined })}</li>
            <li>{fill(strings.previewDuplicatesTemplate, { n: response.preview.duplicatesInFile })}</li>
          </ul>
          {response.preview.sample.length > 0 ? (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted">
                  <tr>
                    {Object.keys(response.preview.sample[0]!).map((k) => (
                      <th key={k} className="border-b border-line px-2 py-1 font-bold">
                        {k}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {response.preview.sample.slice(0, 10).map((row, i) => (
                    <tr key={i}>
                      {Object.keys(response.preview.sample[0]!).map((k) => (
                        <td key={k} className="border-b border-line px-2 py-1">
                          {String(row[k] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      {counts ? (
        <p className="mt-3 rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-pine" data-testid="import-counts">
          {fill(
            strings.commitCountsTemplate,
            { created: counts.created, updated: counts.updated, skipped: counts.skipped, quarantined: counts.quarantined },
          )}
        </p>
      ) : null}

      {errors.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-semibold">
            {strings.importErrors} ({errors.length})
          </summary>
          <ul className="mt-1 list-inside list-disc text-xs text-muted">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
