'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Toast, useToast } from '../../../components/modal';

export interface SecurityStrings {
  title: string;
  subtitle: string;
  statusOn: string;
  statusOff: string;
  statusPending: string;
  recoveryRemaining: string;
  enable: string;
  enabling: string;
  disable: string;
  disabling: string;
  emailLabel: string;
  emailHint: string;
  scanTitle: string;
  secretLabel: string;
  recoveryTitle: string;
  recoveryNote: string;
  confirmTitle: string;
  confirmCta: string;
  confirming: string;
  codeLabel: string;
  savedToast: string;
  disabledToast: string;
  errorInvalidCode: string;
  errorGeneric: string;
}

interface Enrollment {
  secretBase32: string;
  otpauthUri: string;
  qrDataUrl: string;
  recoveryCodes: string[];
}

/**
 * F-03 MFA self-service panel. The whole flow is client-side so the secret,
 * the QR and the recovery codes are rendered exactly once in this browser
 * session; the page (server) only knows the on/off/pending state.
 */
export function SecurityPanel({
  enabled,
  pending,
  unusedCodes,
  strings,
}: {
  enabled: boolean;
  pending: boolean;
  unusedCodes: number;
  strings: SecurityStrings;
}) {
  const router = useRouter();
  const toast = useToast();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [email, setEmail] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableCode, setDisableCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showErrorFor = async (res: Response, fallback: string): Promise<void> => {
    const payload = (await res.json().catch(() => null)) as { code?: string } | null;
    if (res.status === 400 && (payload?.code === 'mfa_invalid_code' || payload?.code === 'mfa_invalid')) {
      setError(strings.errorInvalidCode);
    } else {
      setError(fallback);
    }
  };

  const startEnroll = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/me/mfa/totp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        await showErrorFor(res, strings.errorGeneric);
        return;
      }
      const payload = (await res.json()) as {
        secret_base32: string;
        otpauth_uri: string;
        qr_data_url: string;
        recovery_codes: string[];
      };
      setEnrollment({
        secretBase32: payload.secret_base32,
        otpauthUri: payload.otpauth_uri,
        qrDataUrl: payload.qr_data_url,
        recoveryCodes: payload.recovery_codes,
      });
    } catch {
      setError(strings.errorGeneric);
    } finally {
      setBusy(false);
    }
  };

  const confirmEnroll = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/me/mfa/totp/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: confirmCode }),
      });
      if (!res.ok) {
        await showErrorFor(res, strings.errorGeneric);
        return;
      }
      setEnrollment(null);
      setConfirmCode('');
      toast.show(strings.savedToast);
      router.refresh();
    } catch {
      setError(strings.errorGeneric);
    } finally {
      setBusy(false);
    }
  };

  const doDisable = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/me/mfa', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: disableCode }),
      });
      if (!res.ok) {
        await showErrorFor(res, strings.errorGeneric);
        return;
      }
      setDisableOpen(false);
      setDisableCode('');
      toast.show(strings.disabledToast);
      router.refresh();
    } catch {
      setError(strings.errorGeneric);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" data-testid="sec-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={enabled ? 'chip' : 'chip !bg-paper !text-muted'} data-testid="sec-status">
          {enabled ? strings.statusOn : pending ? strings.statusPending : strings.statusOff}
        </span>
        {enabled ? (
          <span className="text-xs text-muted">{fill(strings.recoveryRemaining, { count: String(unusedCodes) })}</span>
        ) : null}
      </div>

      {error ? (
        <p className="mt-3 text-sm text-red-700" role="alert" data-testid="sec-error">
          {error}
        </p>
      ) : null}

      {/* ── Enabled: disable (requires a current code) ─────────────────── */}
      {enabled ? (
        <div className="mt-4">
          <button
            type="button"
            className="btn-light btn-small"
            disabled={busy}
            onClick={() => {
              setDisableOpen((v) => !v);
              setError(null);
            }}
            data-testid="sec-disable"
          >
            {strings.disable}
          </button>
          {disableOpen ? (
            <div className="mt-3 rounded-xl bg-paper p-3">
              <label className="label" htmlFor="sec-disable-code">
                {strings.confirmTitle}
              </label>
              <div className="mt-1 flex flex-wrap gap-2">
                <input
                  id="sec-disable-code"
                  className="input w-40"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={12}
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value)}
                  data-testid="sec-disable-code-input"
                />
                <button
                  type="button"
                  className="btn-accent btn-small"
                  disabled={busy}
                  onClick={() => void doDisable()}
                  data-testid="sec-disable-confirm"
                >
                  {busy ? strings.disabling : strings.disable}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        /* ── Off / pending: enroll (starts or rotates the pending secret) ── */
        <div className="mt-4 space-y-3">
          {!enrollment ? (
            <>
              <label className="label" htmlFor="sec-email">
                {strings.emailLabel}
              </label>
              <input
                id="sec-email"
                className="input max-w-md"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="sec-email"
              />
              <p className="text-xs text-muted">{strings.emailHint}</p>
              <button
                type="button"
                className="btn-primary btn-small"
                disabled={busy || email.trim().length === 0}
                onClick={() => void startEnroll()}
                data-testid="sec-enable"
              >
                {busy ? strings.enabling : strings.enable}
              </button>
            </>
          ) : (
            <>
              <p className="text-sm font-bold">{strings.scanTitle}</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={enrollment.qrDataUrl}
                alt={strings.scanTitle}
                width={240}
                height={240}
                data-testid="sec-qr"
              />
              <p className="label">{strings.secretLabel}</p>
              <code className="block rounded-lg bg-paper px-3 py-2 text-xs break-all" data-testid="sec-secret">
                {enrollment.secretBase32}
              </code>

              <div className="rounded-xl bg-accent-pale p-3">
                <p className="text-sm font-bold text-accent">{strings.recoveryTitle}</p>
                <p className="mt-1 text-xs text-accent">{strings.recoveryNote}</p>
                <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm" data-testid="sec-recovery-codes">
                  {enrollment.recoveryCodes.map((code) => (
                    <li key={code}>{code}</li>
                  ))}
                </ul>
              </div>

              <label className="label" htmlFor="sec-confirm-code">
                {strings.confirmTitle}
              </label>
              <div className="flex flex-wrap gap-2">
                <input
                  id="sec-confirm-code"
                  className="input w-40"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={12}
                  value={confirmCode}
                  onChange={(e) => setConfirmCode(e.target.value)}
                  data-testid="sec-confirm-code"
                />
                <button
                  type="button"
                  className="btn-primary btn-small"
                  disabled={busy}
                  onClick={() => void confirmEnroll()}
                  data-testid="sec-confirm"
                >
                  {busy ? strings.confirming : strings.confirmCta}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </section>
  );
}

/** Local placeholder interpolation ({name}); mirrors src/i18n/interpolate. */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => vars[key] ?? m);
}
