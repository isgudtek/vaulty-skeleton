/**
 * A small, dependency-free, XSS-safe Markdown parser.
 *
 * It produces a typed tree that the UI renders as React elements — never HTML strings — so raw HTML in the
 * source is shown as literal text. Links are limited to http(s), mailto and in-page anchors; images are never
 * fetched (a zero-knowledge editor must not make remote requests), the alt text is shown instead.
 *
 * Supported: headings, paragraphs, **bold**, *italic*, ~~strike~~, `code`, fenced code blocks, blockquotes,
 * bullet / numbered / task lists (flat), horizontal rules, [links](https://…), backslash escapes.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'br' };

export interface ListItem {
  /** `null` for a normal item, `true`/`false` for a task item. */
  checked: boolean | null;
  c: Inline[];
}

export type Block =
  | { t: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'ul'; items: ListItem[] }
  | { t: 'ol'; start: number; items: ListItem[] }
  | { t: 'hr' };

/** Only http(s), mailto and in-page anchors are linkable; everything else (javascript:, data:, vbscript:…) is dropped. */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (url === '' || /[\u0000-\u0020\u007f]/.test(url)) return null;
  if (/^https?:\/\/[^/]/i.test(url) || /^mailto:[^\s]+$/i.test(url) || /^#[\w-]*$/.test(url)) return url;
  return null;
}

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~>|]/;
const PAIRED = [
  ['**', 'strong'],
  ['__', 'strong'],
  ['~~', 'del'],
] as const;
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9]/.test(c);

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push({ t: 'text', v: buf });
      buf = '';
    }
  };
  let i = 0;

  scan: while (i < src.length) {
    const ch = src[i] as string;
    const rest = src.slice(i);

    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.test(src[i + 1] as string)) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === '\n') {
      if (/ {2,}$/.test(buf)) {
        buf = buf.replace(/ +$/, '');
        flush();
        out.push({ t: 'br' });
      } else {
        buf += ' ';
      }
      i++;
      continue;
    }

    if (ch === '`') {
      let n = 1;
      while (src[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      const end = src.indexOf(fence, i + n);
      if (end !== -1) {
        let body = src.slice(i + n, end).replace(/\n/g, ' ');
        if (body.length > 2 && body.startsWith(' ') && body.endsWith(' ')) body = body.slice(1, -1);
        flush();
        out.push({ t: 'code', v: body });
        i = end + n;
      } else {
        buf += fence;
        i += n;
      }
      continue;
    }

    if (ch === '!') {
      const m = /^!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(rest);
      if (m) {
        buf += `[image: ${m[1] || 'untitled'}]`;
        i += m[0].length;
        continue;
      }
    }

    if (ch === '[') {
      const m = /^\[((?:[^[\]\\]|\\.)*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(rest);
      if (m) {
        const href = safeHref(m[2] as string);
        const children = parseInline(m[1] as string);
        flush();
        if (href) out.push({ t: 'link', href, c: children });
        else out.push(...children);
        i += m[0].length;
        continue;
      }
    }

    // Strong (** or __), strike (~~)
    for (const [marker, kind] of PAIRED) {
      if (!src.startsWith(marker, i)) continue;
      if (marker === '__' && isWordChar(src[i - 1])) continue;
      let end = src.indexOf(marker, i + 2);
      if (end === -1) continue;
      while (src[end + 2] === marker[0]) end++; // **bold *x*** → close on the last marker
      const body = src.slice(i + 2, end);
      if (body === '' || /^\s/.test(body) || /\s$/.test(body)) continue;
      if (marker === '__' && isWordChar(src[end + 2])) continue;
      flush();
      out.push({ t: kind, c: parseInline(body) });
      i = end + 2;
      continue scan;
    }

    // Emphasis (* or _)
    if (ch === '*' || ch === '_') {
      if (!(ch === '_' && isWordChar(src[i - 1])) && src[i + 1] !== ch) {
        let end = src.indexOf(ch, i + 1);
        while (end !== -1 && src[end + 1] === ch) end = src.indexOf(ch, end + 2);
        if (end !== -1) {
          const body = src.slice(i + 1, end);
          const okEdge = body !== '' && !/^\s/.test(body) && !/\s$/.test(body);
          if (okEdge && !(ch === '_' && isWordChar(src[end + 1]))) {
            flush();
            out.push({ t: 'em', c: parseInline(body) });
            i = end + 1;
            continue;
          }
        }
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Blocks                                                                                      */
/* ------------------------------------------------------------------------------------------ */

const RE_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const RE_QUOTE = /^\s{0,3}>/;
const RE_UL = /^\s*[-*+]\s+(.*)$/;
const RE_OL = /^\s*(\d{1,9})[.)]\s+(.*)$/;

const startsBlock = (line: string): boolean =>
  RE_FENCE.test(line) || RE_HEADING.test(line) || RE_HR.test(line) || RE_QUOTE.test(line) || RE_UL.test(line) || RE_OL.test(line);

function listItem(text: string): ListItem {
  const task = /^\[( |x|X)\]\s+(.*)$/.exec(text);
  return task
    ? { checked: task[1] !== ' ', c: parseInline(task[2] as string) }
    : { checked: null, c: parseInline(text) };
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    const fence = RE_FENCE.exec(line);
    if (fence) {
      const marker = fence[1] as string;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i] as string;
        if (new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(l)) {
          i++;
          break;
        }
        body.push(l);
        i++;
      }
      blocks.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      blocks.push({ t: 'heading', level: (heading[1] as string).length as 1 | 2 | 3 | 4 | 5 | 6, c: parseInline(heading[2] as string) });
      i++;
      continue;
    }

    if (RE_HR.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /\S/.test(lines[i] as string) && (RE_QUOTE.test(lines[i] as string) || !startsBlock(lines[i] as string))) {
        inner.push((lines[i] as string).replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      blocks.push({ t: 'quote', c: parseBlocks(inner) });
      continue;
    }

    const ul = RE_UL.exec(line);
    const ol = RE_OL.exec(line);
    if (ul || ol) {
      const ordered = !ul;
      const start = ol ? Number(ol[1]) : 1;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const l = lines[i] as string;
        const m = ordered ? RE_OL.exec(l) : RE_UL.exec(l);
        if (!m || RE_HR.test(l)) break;
        let text = ordered ? (m[2] as string) : (m[1] as string);
        i++;
        // Indented continuation lines belong to the same item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i] as string) && !RE_UL.test(lines[i] as string) && !RE_OL.test(lines[i] as string)) {
          text += ' ' + (lines[i] as string).trim();
          i++;
        }
        items.push(listItem(text));
      }
      blocks.push(ordered ? { t: 'ol', start, items } : { t: 'ul', items });
      continue;
    }

    const para: string[] = [line];
    i++;
    while (i < lines.length && /\S/.test(lines[i] as string) && !startsBlock(lines[i] as string)) {
      para.push(lines[i] as string);
      i++;
    }
    blocks.push({ t: 'p', c: parseInline(para.join('\n').replace(/[ \t]+$/g, '')) });
  }
  return blocks;
}

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, '\n').split('\n'));
}
