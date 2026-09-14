'use client';

import { useState } from 'react';
import type { BadgeCard } from '../../../../../lib/badges';
import { fill } from '../../../../../components/fill';
import { Toast, useToast } from '../../../../../components/modal';

export type { BadgeCard } from '../../../../../lib/badges';

export interface BadgeSheetStrings {
  title: string;
  subtitle: string;
  backLink: string;
  print: string;
  linksTitle: string;
  linksHint: string;
  generate: string;
  generating: string;
  downloadCsv: string;
  csvFilename: string;
  issuesLabel: string;
  excluded: string | null;
  empty: string;
  errorGeneric: string;
  errorNetwork: string;
  qrAltTemplate: string;
}

interface IssuedLink {
  registration_id: string;
  claim_url: string;
  qr_data_url: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The printable badge sheet plus the (screen-only) controls that mint claim
 * links.
 *
 * It is one client component so the two halves share state: issuing links swaps
 * the QRs of the guests who have no card yet, in place, without a page reload —
 * which matters because the plaintext claim token exists exactly once, at
 * issuance, and cannot be re-read from the server afterwards.
 */
export function BadgeSheet({
  eventId,
  cards,
  strings,
  perSheet,
}: {
  eventId: string;
  cards: BadgeCard[];
  strings: BadgeSheetStrings;
  perSheet: number;
}) {
  const toast = useToast();
  const [issued, setIssued] = useState<Record<string, IssuedLink>>({});
  const [csv, setCsv] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const staleCards = cards.filter((c) => c.needsClaimLink && !issued[c.registrationId]);

  const generateLinks = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/organizer/events/${eventId}/badge-links`, { method: 'POST' });
      const body = (await res.json().catch(() => null)) as { links?: IssuedLink[]; csv?: string } | null;
      if (res.ok && body?.links) {
        const next: Record<string, IssuedLink> = { ...issued };
        for (const link of body.links) next[link.registration_id] = link;
        setIssued(next);
        setCsv(body.csv ?? null);
        toast.show(fill(strings.issuesLabel, { n: body.links.length }));
      } else {
        setError(strings.errorGeneric);
      }
    } catch {
      setError(strings.errorNetwork);
    } finally {
      setBusy(false);
    }
  };

  const downloadCsv = (): void => {
    if (!csv) return;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = strings.csvFilename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const sheets = chunk(cards, perSheet);

  return (
    <>
      <section className="card mt-6 no-print" aria-label={strings.linksTitle}>
        <h2 className="text-lg font-bold tracking-tight">{strings.linksTitle}</h2>
        <p className="mt-1 text-xs text-muted">{strings.linksHint}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary btn-small"
            disabled={busy || staleCards.length === 0}
            onClick={() => void generateLinks()}
            data-testid="badges-generate"
          >
            {busy ? strings.generating : strings.generate}
          </button>
          <button
            type="button"
            className="btn-light btn-small"
            disabled={busy || !csv}
            onClick={downloadCsv}
            data-testid="badges-download-csv"
          >
            {strings.downloadCsv}
          </button>
          <button
            type="button"
            className="btn-light btn-small"
            onClick={() => window.print()}
            data-testid="badges-print"
          >
            {strings.print}
          </button>
        </div>
        {error ? (
          <p className="mt-2 text-sm text-red-700" role="alert" data-testid="badges-error">
            {error}
          </p>
        ) : null}
        {strings.excluded ? <p className="mt-2 text-xs text-muted">{strings.excluded}</p> : null}
      </section>

      {cards.length === 0 ? (
        <p className="mt-6 text-sm text-muted no-print">{strings.empty}</p>
      ) : (
        sheets.map((sheet, sheetIndex) => (
          <ul className="badge-sheet mt-6" key={sheetIndex} data-testid="badge-sheet">
            {sheet.map((card) => {
              const link = issued[card.registrationId];
              const qrUrl = link?.claim_url ?? card.qrUrl;
              const qrDataUrl = link?.qr_data_url ?? card.qrDataUrl;
              return (
                <li
                  key={card.registrationId}
                  className="badge-card"
                  data-testid={`badge-${card.registrationId}`}
                  data-qr-url={qrUrl}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- inline SVG data URL, no request is made */}
                  <img src={qrDataUrl} alt={fill(strings.qrAltTemplate, { name: card.name })} width={256} height={256} />
                  <p className="badge-name">{card.name}</p>
                </li>
              );
            })}
          </ul>
        ))
      )}

      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </>
  );
}
