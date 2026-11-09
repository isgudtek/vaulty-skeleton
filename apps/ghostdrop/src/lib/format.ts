/** Pure presentation helpers. No cryptography or storage lives in the app — that is @vaulty/core. */

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

/** `7f3a91c2…` → `7F3A·91C2` — a short, human-comparable vault fingerprint. */
export function fingerprint(namespaceId: string | null): string {
  if (!namespaceId) return '————·————';
  const head = namespaceId.slice(0, 8).toUpperCase();
  return `${head.slice(0, 4)}·${head.slice(4)}`;
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  webm: 'audio/webm',
  mp4: 'video/mp4',
  txt: 'text/plain',
  json: 'application/json',
  zip: 'application/zip',
};

/** Browsers sometimes report an empty `File.type`; fall back to the extension. */
export function guessMime(name: string, reported: string): string {
  if (reported) return reported.split(';')[0]!.trim().toLowerCase();
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export type PreviewKind = 'image' | 'pdf' | 'audio' | 'video' | 'none';

export function previewKind(mime: string): PreviewKind {
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image'; // SVG can carry script
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'none';
}

export function kindGlyph(mime: string): string {
  const k = previewKind(mime);
  if (k === 'image') return 'IMG';
  if (k === 'pdf') return 'PDF';
  if (k === 'audio') return 'AUD';
  if (k === 'video') return 'VID';
  return 'BIN';
}

/** Strip path separators/control characters from a user-supplied download name. */
export function safeFileName(name: string, fallback = 'file'): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : fallback;
}

export function timestampStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function extensionForMime(mime: string): string {
  if (mime === 'audio/webm') return 'webm';
  if (mime === 'audio/mp4') return 'm4a';
  if (mime === 'audio/ogg') return 'ogg';
  if (mime === 'audio/wav') return 'wav';
  return 'bin';
}
