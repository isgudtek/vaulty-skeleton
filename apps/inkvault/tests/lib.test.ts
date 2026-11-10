import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadText,
  fingerprint,
  formatBytes,
  noteFileName,
  stripMd,
  suggestTitle,
  wordCount,
} from '../src/lib/format';

describe('format helpers', () => {
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytes(-1)).toBe('0 B');
  });

  it('builds a short vault fingerprint', () => {
    expect(fingerprint('7f3a91c2aabbccdd')).toBe('7F3A·91C2');
    expect(fingerprint(null)).toBe('————·————');
  });

  it('builds safe .md file names', () => {
    expect(noteFileName('Meeting notes')).toBe('Meeting notes.md');
    expect(noteFileName('already.md')).toBe('already.md');
    expect(noteFileName('Shouting.MD')).toBe('Shouting.md');
    expect(noteFileName('../../etc/passwd')).toBe('.._.._etc_passwd.md');
    expect(noteFileName('a:b*c?d')).toBe('a_b_c_d.md');
    expect(noteFileName('   ')).toBe('Untitled.md');
    expect(noteFileName('x'.repeat(200))).toHaveLength(83); // 80 + ".md"
    expect(stripMd('note.markdown')).toBe('note');
  });

  it('suggests a title from the first heading', () => {
    expect(suggestTitle('intro\n\n## My **Plan** `v2` ##\n\ntext')).toBe('My Plan v2');
    expect(suggestTitle('no headings here')).toBe('');
  });

  it('counts words', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('  one two\nthree\t four ')).toBe(4);
  });
});

describe('downloadText (the explicit plaintext export)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates a markdown blob, clicks a hidden link with the file name, and revokes the URL', () => {
    vi.useFakeTimers();
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => (created.push(b), 'blob:x/1'));
    URL.revokeObjectURL = vi.fn();
    const names: string[] = [];
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      names.push(this.download);
    };
    downloadText('# hi', 'hi.md');
    expect(names).toEqual(['hi.md']);
    expect(created[0]!.type).toBe('text/markdown;charset=utf-8');
    expect(document.querySelector('a[download]')).toBeNull(); // link removed again
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x/1');
    vi.useRealTimers();
  });
});
