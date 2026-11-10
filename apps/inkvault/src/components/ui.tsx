import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId, useRef } from 'react';

type Tone = 'primary' | 'ghost' | 'danger';

const TONES: Record<Tone, string> = {
  primary: 'border-indigo-ink bg-indigo-ink text-white hover:bg-indigo-deep hover:border-indigo-deep',
  ghost: 'border-rule bg-white text-ink hover:border-ink-soft',
  danger: 'border-alert/50 bg-white text-alert hover:bg-red-50',
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
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${TONES[tone]} ${className}`}
    />
  );
}

/** Accessible modal: labelled dialog, Escape to close, focus moved inside on open and restored on close. */
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[data-autofocus], button, input, textarea')?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-3 backdrop-blur-[2px] sm:items-center" role="presentation">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`max-h-[92vh] w-full overflow-y-auto rounded-xl border border-rule bg-paper p-5 shadow-2xl ${wide ? 'max-w-xl' : 'max-w-sm'}`}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id={titleId} className="font-serif text-lg font-semibold">
            {title}
          </h2>
          <Button onClick={onClose} aria-label="Close dialog">
            Close
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ConfirmModal({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title="Are you sure?" onClose={onCancel}>
      <p className="mb-4 text-sm text-ink-soft">{message}</p>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button tone="danger" data-autofocus onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
