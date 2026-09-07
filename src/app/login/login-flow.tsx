'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Toast, useToast } from '../../components/modal';
import { fill } from '../../components/fill';

type Strings = {
  emailLabel: string;
  emailError: string;
  sendCode: string;
  sending: string;
  codeStepTitle: string;
  codeSentToTemplate: string;
  codeLabel: string;
  codeError: string;
  codeInvalid: string;
  verify: string;
  verifying: string;
  changeEmail: string;
  devHintTitle: string;
  devHintCodeTemplate: string;
  devHintNote: string;
  tryAgain: string;
  errorNetwork: string;
  errorRateLimited: string;
};

type Step = 'email' | 'code';

/** Two-step OTP sign-in. devCode hint renders ONLY when the server response contains it. */
export function LoginFlow({ strings, nextPath }: { strings: Strings; nextPath: string | null }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  const request = async () => {
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setEmailError(strings.emailError);
      return;
    }
    setEmailError(null);
    setBusy(true);
    setDevCode(null);
    try {
      const res = await fetch('/api/auth/otp/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: value }),
      });
      const body = (await res.json().catch(() => null)) as { devCode?: string } | null;
      if (res.ok) {
        // Enumeration-safe: the endpoint always answers ok for a valid email,
        // regardless of whether the account existed.
        setDevCode(typeof body?.devCode === 'string' ? body.devCode : null);
        setStep('code');
        setTimeout(() => codeRef.current?.focus(), 50);
      } else if (res.status === 429) {
        toast.show(strings.errorRateLimited, 'error');
      } else {
        toast.show(strings.emailError, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    const value = code.trim();
    if (!/^\d{6}$/.test(value)) {
      setCodeError(strings.codeError);
      return;
    }
    setCodeError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code: value }),
      });
      if (res.ok) {
        router.replace(nextPath && nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : '/me');
      } else if (res.status === 401 || res.status === 400) {
        setCodeError(strings.codeInvalid);
      } else {
        toast.show(strings.errorNetwork, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {step === 'email' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void request();
          }}
          noValidate
        >
          <label className="label" htmlFor="login-email">
            {strings.emailLabel}
          </label>
          <input
            id="login-email"
            ref={emailRef}
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? 'login-email-error' : undefined}
            data-testid="login-email"
          />
          {emailError ? (
            <p id="login-email-error" className="field-error">
              {emailError}
            </p>
          ) : null}
          <button type="submit" className="btn-primary mt-4 w-full" disabled={busy} data-testid="login-request">
            {busy ? strings.sending : strings.sendCode}
          </button>
        </form>
      ) : (
        <div>
          <h2 className="text-lg font-bold tracking-tight">{strings.codeStepTitle}</h2>
          <p className="mt-1 text-sm text-muted">{fill(strings.codeSentToTemplate, { email: email.trim() })}</p>
          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              void verify();
            }}
            noValidate
          >
            <label className="label" htmlFor="login-code">
              {strings.codeLabel}
            </label>
            <input
              id="login-code"
              ref={codeRef}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="\d{6}"
              className="input tracking-[0.4em]"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              aria-invalid={codeError ? true : undefined}
              aria-describedby={codeError ? 'login-code-error' : undefined}
              data-testid="login-code"
            />
            {codeError ? (
              <p id="login-code-error" className="field-error" data-testid="login-code-error">
                {codeError}
              </p>
            ) : null}
            <button type="submit" className="btn-primary mt-4 w-full" disabled={busy} data-testid="login-verify">
              {busy ? strings.verifying : strings.verify}
            </button>
          </form>
          {devCode ? (
            <div className="mt-4 rounded-xl border border-dashed border-accent/50 bg-accent-pale p-3 text-sm" data-testid="dev-hint">
              <p className="font-bold text-accent">{strings.devHintTitle}</p>
              <p className="mt-1 font-mono text-base tracking-widest">{fill(strings.devHintCodeTemplate, { code: devCode })}</p>
              <p className="mt-1 text-xs text-muted">{strings.devHintNote}</p>
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap justify-between gap-2 text-sm">
            <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={() => setStep('email')}>
              {strings.changeEmail}
            </button>
            <button type="button" className="underline underline-offset-2 hover:text-ink" disabled={busy} onClick={() => void request()}>
              {strings.tryAgain}
            </button>
          </div>
        </div>
      )}
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </div>
  );
}
