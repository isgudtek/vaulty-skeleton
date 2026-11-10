/** Pure presentation + file helpers. No cryptography or storage lives in the app — that is @vaulty/core. */

export const NOTE_MIME = 'text/markdown';
export const NOTE_TAG = 'note';

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** `7f3a91c2…` → `7F3A·91C2` — a short, human-comparable vault fingerprint. */
export function fingerprint(namespaceId: string | null): string {
  if (!namespaceId) return '————·————';
  const head = namespaceId.slice(0, 8).toUpperCase();
  return `${head.slice(0, 4)}·${head.slice(4)}`;
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Remove a trailing `.md` so the title field shows the human name. */
export function stripMd(name: string): string {
  return name.replace(/\.(md|markdown)$/i, '');
}

/** A safe, human file name: no path separators/control chars, max 80 chars, always ends in `.md`. */
export function noteFileName(title: string): string {
  const cleaned = stripMd(title).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 80);
  return `${cleaned || 'Untitled'}.md`;
}

/** First Markdown heading, used to suggest a title for an unnamed note. */
export function suggestTitle(markdown: string): string {
  const m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(markdown);
  return m ? (m[1] as string).replace(/[*_`~[\]]/g, '').slice(0, 80) : '';
}

export function wordCount(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Download plaintext (the explicit, user-initiated "Download .md" path) and release the object URL promptly. */
export function downloadText(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Indigo-on-paper skin for @vaulty/core/react's <PatternGrid />. */
export const GRID_SKIN = {
  nodeColor: '#94A3B8',
  activeColor: '#4F46E5',
  lineColor: '#4F46E5',
} as const;
