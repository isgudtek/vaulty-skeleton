/** Pure presentation + file helpers. No cryptography or storage lives in the app — that is @vaulty/core. */

export function fingerprint(namespaceId: string | null): string {
  if (!namespaceId) return '————·————';
  const head = namespaceId.slice(0, 8).toUpperCase();
  return `${head.slice(0, 4)}·${head.slice(4)}`;
}

export function timestampStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read file'));
    reader.readAsArrayBuffer(blob);
  });
}

export function downloadBytes(bytes: Uint8Array, fileName: string, mimeType = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_');
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function samePattern(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

/** Amber-on-carbon skin for @vaulty/core/react's <PatternGrid /> (a hardware-keypad look). */
export const GRID_SKIN = {
  nodeColor: '#52525B',
  activeColor: '#F59E0B',
  lineColor: '#F59E0B',
} as const;
