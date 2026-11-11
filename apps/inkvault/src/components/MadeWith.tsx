/** "Made with Vaulty Skeleton" badge. The logo is a same-origin static file (public/), so the CSP stays `img-src 'self'`. */
export function MadeWith() {
  return (
    <a
      href="https://github.com/isgudtek/vaulty-skeleton"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-ink-soft transition-colors hover:text-indigo-ink focus-visible:text-indigo-ink"
    >
      <img src="./vaulty-skeleton.png" alt="" width={16} height={16} />
      Made with Vaulty Skeleton
    </a>
  );
}
