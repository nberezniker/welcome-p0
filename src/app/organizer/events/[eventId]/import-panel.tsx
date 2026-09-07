'use client';

import { useState } from 'react';

interface PreviewData {
  totalRows: number;
  validEmails: number;
  invalidEmails: number;
  quarantined: number;
  duplicatesInFile: number;
  sample: Record<string, unknown>[];
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
  previewTotal: (n: number) => string;
  previewValid: (n: number) => string;
  previewInvalid: (n: number) => string;
  previewQuarantined: (n: number) => string;
  previewDuplicates: (n: number) => string;
  commitCounts: (c: CommitCounts) => string;
  importErrors: string;
  errorGeneric: string;
  errorNetwork: string;
};

/** CSV import UI: file → preview (mapped columns, quarantined, errors) → commit. */
export function ImportPanel({ eventId, strings }: { eventId: string; strings: Strings }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [counts, setCounts] = useState<CommitCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (mode: 'preview' | 'commit') => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const text = await file.text();
      const res = await fetch(`/api/events/${eventId}/imports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csv_text: text, mode }),
      });
      const body = (await res.json().catch(() => null)) as
        | { preview?: PreviewData; counts?: CommitCounts; errors?: string[]; message?: string }
        | null;
      if (res.ok) {
        if (mode === 'preview' && body?.preview) {
          setPreview(body.preview);
          setCounts(null);
        } else if (mode === 'commit' && body?.counts) {
          setCounts(body.counts);
          setPreview(null);
        }
        setErrors(body?.errors ?? []);
      } else {
        setError(body?.message ?? strings.errorGeneric);
      }
    } catch {
      setError(strings.errorNetwork);
    } finally {
      setBusy(false);
    }
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
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
            setCounts(null);
            setErrors([]);
          }}
          data-testid="import-file"
        />
        <button type="button" className="btn-light btn-small" disabled={!file || busy} onClick={() => void send('preview')} data-testid="import-preview">
          {strings.importPreview}
        </button>
        {preview ? (
          <button type="button" className="btn-primary btn-small" disabled={busy} onClick={() => void send('commit')} data-testid="import-commit">
            {busy ? strings.importing : strings.importCommit}
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      {preview ? (
        <div className="mt-4" data-testid="import-preview-panel">
          <p className="text-sm font-bold">{strings.previewTitle}</p>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <li>{strings.previewTotal(preview.totalRows)}</li>
            <li>{strings.previewValid(preview.validEmails)}</li>
            <li>{strings.previewInvalid(preview.invalidEmails)}</li>
            <li>{strings.previewQuarantined(preview.quarantined)}</li>
            <li>{strings.previewDuplicates(preview.duplicatesInFile)}</li>
          </ul>
          {preview.sample.length > 0 ? (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted">
                  <tr>
                    {Object.keys(preview.sample[0]!).map((k) => (
                      <th key={k} className="border-b border-line px-2 py-1 font-bold">
                        {k}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.slice(0, 10).map((row, i) => (
                    <tr key={i}>
                      {Object.keys(preview.sample[0]!).map((k) => (
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
          {strings.commitCounts(counts)}
        </p>
      ) : null}

      {errors.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-semibold">{strings.importErrors} ({errors.length})</summary>
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
