import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId, useRef } from 'react';

type Tone = 'primary' | 'ghost' | 'danger';

const TONES: Record<Tone, string> = {
  primary: 'border-carbon bg-amber-key text-carbon hover:bg-amber-400 shadow-[0_3px_0_0_#18181b] active:translate-y-[2px] active:shadow-[0_1px_0_0_#18181b]',
  ghost: 'border-carbon bg-white text-carbon hover:bg-zinc-100 shadow-[0_3px_0_0_#18181b] active:translate-y-[2px] active:shadow-[0_1px_0_0_#18181b]',
  danger: 'border-alert bg-white text-alert hover:bg-red-50 shadow-[0_3px_0_0_#dc2626] active:translate-y-[2px] active:shadow-[0_1px_0_0_#dc2626]',
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
      className={`inline-flex items-center justify-center gap-2 rounded-md border-2 px-3 py-2 text-xs font-bold uppercase tracking-wider transition-[transform,box-shadow,background-color] disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 ${TONES[tone]} ${className}`}
    />
  );
}

export function Card({
  title,
  hint,
  children,
  className = '',
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border-2 border-carbon bg-white p-4 ${className}`}>
      <header className="mb-3 flex items-center justify-between gap-3 border-b-2 border-carbon pb-2">
        <h2 className="text-sm font-black uppercase tracking-[0.15em]">{title}</h2>
        {hint ? <span className="font-mono text-[11px] uppercase text-zinc-500">{hint}</span> : null}
      </header>
      {children}
    </section>
  );
}

/** Dark "display" strip with amber monospace text, like a hardware wallet screen. */
export function Lcd({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-md border-2 border-carbon bg-carbon px-3 py-2 font-mono text-xs text-amber-key ${className}`}>
      {children}
    </div>
  );
}

export function Led({ on = true }: { on?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2.5 w-2.5 rounded-full border border-carbon ${on ? 'led-blink bg-amber-key' : 'bg-zinc-300'}`}
    />
  );
}

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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-carbon/70 p-3 sm:items-center" role="presentation">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`max-h-[92vh] w-full overflow-y-auto rounded-xl border-2 border-carbon bg-paper p-5 shadow-[8px_8px_0_0_#18181b] ${wide ? 'max-w-2xl' : 'max-w-md'}`}
      >
        <div className="mb-4 flex items-center justify-between gap-3 border-b-2 border-carbon pb-2">
          <h2 id={titleId} className="text-sm font-black uppercase tracking-[0.15em]">
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

export const inputClass =
  'w-full rounded-md border-2 border-carbon bg-white px-3 py-2 text-sm text-carbon placeholder:text-zinc-400';
export const labelClass = 'block text-[11px] font-black uppercase tracking-wider text-zinc-600';
