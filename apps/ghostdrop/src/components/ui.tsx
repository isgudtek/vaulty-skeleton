import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId, useRef } from 'react';

type Tone = 'primary' | 'ghost' | 'danger';

const TONES: Record<Tone, string> = {
  primary:
    'border-emerald-signal/60 bg-emerald-signal/10 text-emerald-300 hover:bg-emerald-signal/20 disabled:hover:bg-emerald-signal/10',
  ghost: 'border-line bg-panel-2 text-slate-300 hover:border-slate-500 disabled:hover:border-line',
  danger: 'border-alert/60 bg-alert/10 text-rose-300 hover:bg-alert/20 disabled:hover:bg-alert/10',
};

export function Button({
  tone = 'ghost',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 font-mono text-xs uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${TONES[tone]} ${className}`}
    />
  );
}

export function Panel({
  title,
  hint,
  children,
  className = '',
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-line bg-panel/90 p-4 backdrop-blur ${className}`}>
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-emerald-signal">{title}</h2>
        {hint ? <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{hint}</span> : null}
      </header>
      {children}
    </section>
  );
}

export function StatusDot({ on = true }: { on?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 rounded-full ${on ? 'pulse-dot bg-emerald-signal' : 'bg-slate-600'}`}
    />
  );
}

/** Accessible modal: labelled dialog, Escape to close, focus moved inside on open and restored on close. */
export function Modal({
  title,
  onClose,
  children,
  wide = false,
  dismissible = true,
}: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  wide?: boolean;
  dismissible?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[data-autofocus], button, input, textarea')?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    if (!dismissible || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dismissible, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-3 sm:items-center" role="presentation">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`max-h-[92vh] w-full overflow-y-auto rounded-lg border border-emerald-signal/40 bg-obsidian p-5 shadow-[0_0_60px_rgba(16,185,129,0.12)] ${wide ? 'max-w-3xl' : 'max-w-md'}`}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id={titleId} className="font-mono text-sm font-semibold uppercase tracking-[0.18em] text-emerald-signal">
            {title}
          </h2>
          {dismissible && onClose ? (
            <Button onClick={onClose} aria-label="Close dialog">
              Close
            </Button>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
}
