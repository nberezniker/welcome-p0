'use client';

import { useRef, useState } from 'react';
import { fill } from '../../../components/fill';

export interface ContactImportStrings {
  title: string;
  subtitle: string;
  fileLabel: string;
  fileHint: string;
  textLabel: string;
  submit: string;
  searching: string;
  resultSome: string;
  resultOne: string;
  resultNone: string;
  unmatched: string;
  skipped: string;
  matchesTruncated: string;
  openCard: string;
  note: string;
  errorNoContacts: string;
  errorCsv: string;
  errorTooLarge: string;
  errorRateLimited: string;
  errorGeneric: string;
  errorUnauthorized: string;
  errorNetwork: string;
}

interface Match {
  display_name: string;
  slug: string;
  headline: string | null;
}

interface ImportResult {
  scanned: number;
  matched_count: number;
  matched: Match[];
  unmatched_count: number;
  matched_truncated: boolean;
  skipped: number;
}

/**
 * "Import your contacts" (interop §A1): one card for both contact formats —
 * the registry has two contact rows (.vcf and .csv), but a user has ONE address
 * book, and duplicating this panel per format would only duplicate the testids.
 *
 * The promise the copy makes is the promise the endpoint keeps: the file is read
 * in memory, matched against the addresses WELCOME already holds, and discarded.
 * Nothing in this component copies the address book into state longer than the
 * request needs it (`content` is cleared as soon as the answer is in), and the
 * result renders names and links only — never an address.
 */
export function ContactImportPanel({ strings }: { strings: ContactImportStrings }) {
  const [content, setContent] = useState('');
  const [filename, setFilename] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const errorForCode = (code: string | undefined, status: number): string => {
    if (status === 401) return strings.errorUnauthorized;
    switch (code) {
      case 'no_contacts':
        return strings.errorNoContacts;
      case 'csv_parse_error':
        return strings.errorCsv;
      case 'payload_too_large':
        return strings.errorTooLarge;
      case 'rate_limited':
        return strings.errorRateLimited;
      default:
        return strings.errorGeneric;
    }
  };

  const onFile = async (file: File | null) => {
    setError(null);
    setResult(null);
    setFileName(file ? file.name : null);
    if (!file) {
      setContent('');
      setFilename(null);
      return;
    }
    // Read locally: the file never leaves the browser until the user submits.
    setContent(await file.text());
    setFilename(file.name);
  };

  const submit = async () => {
    if (content.trim().length === 0) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/me/contacts/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, ...(filename ? { filename } : {}) }),
      });
      const payload = (await res.json().catch(() => null)) as
        | (Partial<ImportResult> & { code?: string })
        | null;
      if (!res.ok) {
        setError(errorForCode(payload?.code, res.status));
        return;
      }
      setResult({
        scanned: payload?.scanned ?? 0,
        matched_count: payload?.matched_count ?? 0,
        matched: payload?.matched ?? [],
        unmatched_count: payload?.unmatched_count ?? 0,
        matched_truncated: payload?.matched_truncated ?? false,
        skipped: payload?.skipped ?? 0,
      });
      // The address book has been answered: drop it from the page.
      setContent('');
      setFilename(null);
      setFileName(null);
      if (fileInput.current) fileInput.current.value = '';
    } catch {
      setError(strings.errorNetwork);
    } finally {
      setBusy(false);
    }
  };

  const headline =
    result === null
      ? null
      : result.matched_count === 0
        ? fill(strings.resultNone, { count: result.scanned })
        : result.matched_count === 1
          ? strings.resultOne
          : fill(strings.resultSome, { count: result.matched_count });

  return (
    <section className="card mt-8" data-testid="contact-import">
      <h2 className="text-lg font-bold tracking-tight">{strings.title}</h2>
      <p className="mt-1.5 text-sm text-muted">{strings.subtitle}</p>

      <div className="mt-4 flex flex-col gap-3">
        <div>
          <label className="text-sm font-semibold" htmlFor="contact-import-file">
            {strings.fileLabel}
          </label>
          <input
            id="contact-import-file"
            ref={fileInput}
            type="file"
            accept=".vcf,.csv,text/vcard,text/csv"
            data-testid="contact-import-file"
            className="mt-1 block w-full text-sm"
            onChange={(event) => {
              void onFile(event.target.files?.[0] ?? null);
            }}
          />
          <p className="mt-1 text-xs text-muted">
            {strings.fileHint}
            {fileName ? ` ${fileName}` : ''}
          </p>
        </div>

        <div>
          <label className="text-sm font-semibold" htmlFor="contact-import-text">
            {strings.textLabel}
          </label>
          <textarea
            id="contact-import-text"
            data-testid="contact-import-text"
            className="input mt-1 h-28 w-full font-mono text-xs"
            value={content}
            onChange={(event) => {
              setContent(event.target.value);
              setFilename(null);
              setFileName(null);
            }}
          />
        </div>

        <div>
          <button
            type="button"
            className="btn"
            data-testid="contact-import-submit"
            disabled={busy || content.trim().length === 0}
            onClick={() => {
              void submit();
            }}
          >
            {busy ? strings.searching : strings.submit}
          </button>
        </div>
      </div>

      {error ? (
        <p className="mt-3 text-sm text-amber-900" role="alert" data-testid="contact-import-error">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="mt-4 rounded-xl bg-paper px-4 py-3" data-testid="contact-import-result" aria-live="polite">
          <p className="text-sm font-semibold" data-testid="contact-import-headline">
            {headline}
          </p>
          {result.matched.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1.5 text-sm">
              {result.matched.map((match) => (
                <li key={match.slug} data-testid="contact-import-match">
                  <a className="font-semibold underline" href={`/p/${match.slug}`}>
                    {match.display_name}
                  </a>
                  {match.headline ? <span className="text-muted"> — {match.headline}</span> : null}
                  <span className="text-muted"> · {strings.openCard}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2 text-xs text-muted">
            {result.unmatched_count > 0 ? `${fill(strings.unmatched, { count: result.unmatched_count })} ` : ''}
            {result.skipped > 0 ? `${fill(strings.skipped, { count: result.skipped })} ` : ''}
            {result.matched_truncated ? strings.matchesTruncated : ''}
          </p>
        </div>
      ) : null}

      {/* The privacy promise sits with the action, not only in the block below. */}
      <p className="mt-4 text-xs text-muted" data-testid="contact-import-note">
        {strings.note}
      </p>
    </section>
  );
}
