'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal, Toast, useToast } from '../../../components/modal';
import { fill } from '../../../components/fill';

export interface ConsentToggleRow {
  purpose: string;
  granted: boolean;
  label: string;
  description: string;
}

export interface BlockRow {
  target_account_id: string;
  created_at: string;
  label: string;
}

type Strings = {
  consentsTitle: string;
  consentsHint: string;
  granted: string;
  notGranted: string;
  actionGrant: string;
  actionWithdraw: string;
  blocksTitle: string;
  blocksEmpty: string;
  unblock: string;
  exportTitle: string;
  exportText: string;
  exportDisclosure: string;
  exportButton: string;
  exporting: string;
  deleteTitle: string;
  deleteText: string;
  deleteButton: string;
  deleteModalTitle: string;
  deleteStep1: string;
  deleteStep2Template: string;
  deleteConfirmPlaceholder: string;
  deleteConfirmButton: string;
  deleteNameMismatch: string;
  deleteFailed: string;
  cancel: string;
  errorNetwork: string;
};

export const CONSENT_PURPOSES_UI = [
  'public_card',
  'event_directory',
  'introduction_fields',
  'service_channel',
  'organizer_marketing',
  'product_marketing',
] as const;

/** Privacy panel: consent toggles, blocks, export, delete account. */
export function PrivacyPanel({
  purposeRows,
  blocks,
  displayName,
  policyVersion,
  strings,
}: {
  purposeRows: ConsentToggleRow[];
  blocks: BlockRow[];
  displayName: string | null;
  policyVersion: string;
  strings: Strings;
}) {
  const [rows, setRows] = useState(purposeRows);
  const [blocksState, setBlocksState] = useState(blocks);
  const [busyPurpose, setBusyPurpose] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [ackChecked, setAckChecked] = useState(false);
  const [typedName, setTypedName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();
  const router = useRouter();

  const toggleConsent = async (purpose: string, granted: boolean) => {
    setBusyPurpose(purpose);
    try {
      const res = await fetch('/api/consents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: granted ? 'grant' : 'withdraw',
          purpose,
          scope_type: 'global',
          scope_id: null,
          policy_version: policyVersion,
        }),
      });
      if (res.ok) {
        setRows((prev) => prev.map((r) => (r.purpose === purpose ? { ...r, granted } : r)));
      } else {
        toast.show(strings.errorNetwork, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusyPurpose(null);
    }
  };

  const unblock = async (target: string) => {
    try {
      const res = await fetch(`/api/blocks/${target}`, { method: 'DELETE' });
      if (res.ok) {
        setBlocksState((prev) => prev.filter((b) => b.target_account_id !== target));
      } else {
        toast.show(strings.errorNetwork, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    }
  };

  const exportData = async () => {
    setExporting(true);
    try {
      const res = await fetch('/api/me/export', { method: 'POST' });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `welcome-export-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        toast.show(strings.errorNetwork, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setExporting(false);
    }
  };

  const deleteAccount = async () => {
    setDeleting(true);
    try {
      const res = await fetch('/api/me', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: typedName }),
      });
      if (res.ok) {
        // Account is gone and the session cookie was cleared server-side; router navigation
        // refetches server components, so the landing renders in the logged-out state.
        router.push('/?deleted=1');
      } else if (res.status === 400) {
        toast.show(strings.deleteNameMismatch, 'error');
      } else {
        toast.show(strings.deleteFailed, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setDeleting(false);
    }
  };

  const canDelete = ackChecked && displayName !== null && typedName === displayName;

  return (
    <div className="flex flex-col gap-8">
      {/* Consents */}
      <section aria-labelledby="consents-heading">
        <h2 id="consents-heading" className="text-lg font-bold tracking-tight">
          {strings.consentsTitle}
        </h2>
        <p className="mt-1 text-xs text-muted">{strings.consentsHint}</p>
        <ul className="mt-3 flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.purpose} className="card-tight flex flex-wrap items-start justify-between gap-3" data-testid={`consent-${row.purpose}`}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold">{row.label}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{row.description}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className={row.granted ? 'chip' : 'chip !bg-paper !text-muted'} data-testid={`consent-state-${row.purpose}`}>
                  {row.granted ? strings.granted : strings.notGranted}
                </span>
                <button
                  type="button"
                  className={row.granted ? 'btn-light btn-small' : 'btn-primary btn-small'}
                  disabled={busyPurpose === row.purpose}
                  onClick={() => void toggleConsent(row.purpose, !row.granted)}
                  data-testid={`consent-toggle-${row.purpose}`}
                >
                  {row.granted ? strings.actionWithdraw : strings.actionGrant}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Blocks */}
      <section aria-labelledby="blocks-heading">
        <h2 id="blocks-heading" className="text-lg font-bold tracking-tight">
          {strings.blocksTitle}
        </h2>
        {blocksState.length === 0 ? (
          <p className="mt-2 text-sm text-muted">{strings.blocksEmpty}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {blocksState.map((b) => (
              <li key={b.target_account_id} className="card-tight flex items-center justify-between gap-3">
                <span className="text-sm">{b.label}</span>
                <button type="button" className="btn-light btn-small" onClick={() => void unblock(b.target_account_id)}>
                  {strings.unblock}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Export */}
      <section aria-labelledby="export-heading" className="card">
        <h2 id="export-heading" className="text-lg font-bold tracking-tight">
          {strings.exportTitle}
        </h2>
        <p className="mt-1 text-sm text-muted">{strings.exportText}</p>
        <button type="button" className="btn-outline btn-small mt-3" disabled={exporting} onClick={() => void exportData()} data-testid="export-button">
          {exporting ? strings.exporting : strings.exportButton}
        </button>
        <p className="mt-2 text-xs text-muted">{strings.exportDisclosure}</p>
      </section>

      {/* Delete account */}
      <section aria-labelledby="delete-heading" className="rounded-2xl border border-red-200 bg-red-50/60 p-6">
        <h2 id="delete-heading" className="text-lg font-bold tracking-tight text-red-900">
          {strings.deleteTitle}
        </h2>
        <p className="mt-1 text-sm text-red-900/80">{strings.deleteText}</p>
        <button type="button" className="btn-danger btn-small mt-3" onClick={() => setDeleteOpen(true)} data-testid="delete-account-open">
          {strings.deleteButton}
        </button>
      </section>

      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title={strings.deleteModalTitle}>
        <div className="flex flex-col gap-4">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 size-4"
              checked={ackChecked}
              onChange={(e) => setAckChecked(e.target.checked)}
              data-testid="delete-ack"
            />
            <span>{strings.deleteStep1}</span>
          </label>
          <div>
            <label className="label" htmlFor="delete-confirm-name">
              {fill(strings.deleteStep2Template, { name: displayName ?? '' })}
            </label>
            <input
              id="delete-confirm-name"
              className="input"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              placeholder={strings.deleteConfirmPlaceholder}
              autoComplete="off"
              data-testid="delete-confirm-input"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-light btn-small" onClick={() => setDeleteOpen(false)}>
              {strings.cancel}
            </button>
            <button
              type="button"
              className="btn-danger btn-small"
              disabled={!canDelete || deleting}
              onClick={() => void deleteAccount()}
              data-testid="delete-account-confirm"
            >
              {strings.deleteConfirmButton}
            </button>
          </div>
        </div>
      </Modal>
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </div>
  );
}
