/** "Made with Vaulty Skeleton" badge. The logo is a same-origin static file (public/), so the CSP stays `img-src 'self'`. */
export function MadeWith() {
  return (
    <p className="py-4 text-center">
      <a
        href="https://github.com/isgudtek/vaulty-skeleton"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500 transition-colors hover:text-emerald-signal focus-visible:text-emerald-signal"
      >
        <img src="./vaulty-skeleton.png" alt="" width={20} height={20} />
        Made with Vaulty Skeleton
      </a>
    </p>
  );
}
