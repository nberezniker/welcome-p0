'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Accessible modal: Escape closes, focus is trapped inside, focus returns to
 * the opener on close. No dependencies; content stays server-escaped.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>('[data-autofocus]')?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab' && panel) {
        const focusables = panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      restoreRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-4 sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="modal-backdrop"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="card max-h-[90vh] w-full max-w-lg overflow-y-auto"
      >
        <div className="mb-3 flex items-start justify-between gap-4">
          <h2 className="text-lg font-bold tracking-tight">{title}</h2>
          <button type="button" className="btn-light btn-small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Inline transient message with live-region semantics. */
export function Toast({
  message,
  kind,
  onDone,
}: {
  message: string | null;
  kind: 'success' | 'error';
  onDone: () => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!message) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(onDone, 5000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [message, kind, onDone]);
  if (!message) return null;
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      className={
        kind === 'error'
          ? 'rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800'
          : 'rounded-lg border border-pine/20 bg-mint px-3 py-2 text-sm text-pine'
      }
      data-testid={`toast-${kind}`}
    >
      {message}
    </div>
  );
}

/** Simple toast state helper for client forms. */
export function useToast(): {
  message: string | null;
  kind: 'success' | 'error';
  show: (msg: string, kind?: 'success' | 'error') => void;
  clear: () => void;
} {
  const [message, setMessage] = useState<string | null>(null);
  const [kind, setKind] = useState<'success' | 'error'>('success');
  return {
    message,
    kind,
    show: (msg, k = 'success') => {
      setKind(k);
      setMessage(msg);
    },
    clear: () => setMessage(null),
  };
}
