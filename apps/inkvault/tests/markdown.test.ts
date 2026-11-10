import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Preview } from '../src/components/Preview';
import { parseInline, parseMarkdown, safeHref } from '../src/lib/markdown';

const html = (md: string) => renderToStaticMarkup(createElement(Preview, { source: md }));
const body = (md: string) => html(md).replace(/^<div class="md" data-testid="preview">/, '').replace(/<\/div>$/, '');

describe('Markdown blocks', () => {
  it('renders headings 1–6 and ignores #hashtag / trailing hashes correctly', () => {
    expect(body('# One\n\n## Two\n\n###### Six')).toBe('<h1>One</h1><h2>Two</h2><h6>Six</h6>');
    expect(body('# C#')).toBe('<h1>C#</h1>');
    expect(body('## Title ##')).toBe('<h2>Title</h2>');
    expect(body('#hashtag')).toBe('<p>#hashtag</p>');
  });

  it('renders paragraphs, soft breaks as spaces and two-space hard breaks as <br>', () => {
    expect(body('one\ntwo\n\nthree')).toBe('<p>one two</p><p>three</p>');
    expect(body('one  \ntwo')).toBe('<p>one<br/>two</p>');
  });

  it('renders fenced code verbatim (escaped, not parsed) and tolerates an unclosed fence', () => {
    const out = body('```ts\nconst a = "<b>**x**</b>";\n  indented\n```\nafter');
    expect(out).toContain('<pre data-lang="ts"><code>const a = &quot;&lt;b&gt;**x**&lt;/b&gt;&quot;;\n  indented</code></pre>');
    expect(out).toContain('<p>after</p>');
    expect(body('~~~\nopen ended')).toBe('<pre><code>open ended</code></pre>');
  });

  it('renders bullet, numbered and task lists', () => {
    expect(body('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(body('3. c\n4. d')).toBe('<ol start="3"><li>c</li><li>d</li></ol>');
    const tasks = body('- [x] done\n- [ ] todo');
    expect(tasks.match(/<li class="task">/g)).toHaveLength(2);
    expect(tasks.match(/type="checkbox"/g)).toHaveLength(2);
    expect(tasks.match(/checked=""/g)).toHaveLength(1); // only the [x] item is checked
    expect(tasks).toContain('aria-label="Done"');
    expect(tasks).toContain('aria-label="To do"');
    expect(body('- first\n  continues here\n- second')).toBe('<ul><li>first continues here</li><li>second</li></ul>');
  });

  it('renders blockquotes (with nested blocks and lazy continuation)', () => {
    expect(body('> quote\n> more')).toBe('<blockquote><p>quote more</p></blockquote>');
    expect(body('> # Head\n> - item')).toBe('<blockquote><h1>Head</h1><ul><li>item</li></ul></blockquote>');
    expect(body('> lazy\ncontinuation')).toBe('<blockquote><p>lazy continuation</p></blockquote>');
  });

  it('renders horizontal rules, and treats "- - -" as a rule, not a list', () => {
    for (const hr of ['---', '***', '___', '- - -', '*  *  *']) expect(body(hr), hr).toBe('<hr/>');
    expect(body('a\n\n---\n\nb')).toBe('<p>a</p><hr/><p>b</p>');
  });

  it('normalises CRLF and handles empty input with a placeholder', () => {
    expect(body('# A\r\n\r\ntext')).toBe('<h1>A</h1><p>text</p>');
    expect(html('')).toContain('Your rendered note appears here.');
    expect(parseMarkdown('   \n\n  ')).toEqual([]);
  });
});

describe('Markdown inline', () => {
  it('renders strong, emphasis, strike and code', () => {
    expect(body('**b** *i* _i2_ __b2__ ~~s~~ `c`')).toBe(
      '<p><strong>b</strong> <em>i</em> <em>i2</em> <strong>b2</strong> <del>s</del> <code>c</code></p>',
    );
  });

  it('nests emphasis inside strong, and handles ***both***', () => {
    expect(body('**bold *and italic***')).toBe('<p><strong>bold <em>and italic</em></strong></p>');
    expect(body('**a `code` b**')).toBe('<p><strong>a <code>code</code> b</strong></p>');
  });

  it('does not italicise snake_case or mid-word underscores, nor stray asterisks', () => {
    expect(body('snake_case_name and 2 * 3 * 4')).toBe('<p>snake_case_name and 2 * 3 * 4</p>');
    expect(body('a * b')).toBe('<p>a * b</p>');
    expect(body('**unclosed')).toBe('<p>**unclosed</p>');
  });

  it('supports backslash escapes and multi-backtick code spans', () => {
    expect(body('\\*not em\\* \\# \\[x\\]')).toBe('<p>*not em* # [x]</p>');
    expect(body('``a`b``')).toBe('<p><code>a`b</code></p>');
    expect(body('`` ` ``')).toBe('<p><code>`</code></p>');
    expect(body('a ` lonely')).toBe('<p>a ` lonely</p>');
  });

  it('renders safe links with hardened attributes, including formatted link text', () => {
    expect(body('[**Docs**](https://example.com/a?b=1)')).toBe(
      '<p><a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer nofollow"><strong>Docs</strong></a></p>',
    );
    expect(body('[mail](mailto:a@b.co) [top](#intro)')).toContain('href="mailto:a@b.co"');
    expect(body('[top](#intro)')).toContain('href="#intro"');
  });

  it('exposes the inline tree for programmatic use', () => {
    expect(parseInline('a **b**')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'strong', c: [{ t: 'text', v: 'b' }] },
    ]);
  });
});

describe('Markdown safety (XSS)', () => {
  it('never emits raw HTML: tags in the source become literal text', () => {
    const out = body('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<b onmouseover="x()">hi</b>');
    expect(out).not.toMatch(/<script|<img[ >]|<b[ >]/); // no real tags — they only appear escaped, as text
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'file:///etc/passwd',
    '//evil.example/x',
    'ftp://example.com',
    '/relative/path',
    '&#106;avascript:alert(1)',
  ])('drops the link for unsafe URL %s but keeps the text', (url) => {
    const out = body(`[click me](${url})`);
    expect(out).not.toContain('<a ');
    expect(out).not.toContain('href=');
    expect(out).toContain('click me');
  });

  it('does not treat URLs with whitespace tricks as links', () => {
    expect(body('[x](java\nscript:alert(1))')).not.toContain('<a ');
    expect(body('[x]( javascript:alert(1))')).not.toContain('<a ');
    expect(body('[x](https://a.co "title")')).toContain('href="https://a.co"');
  });

  it('never loads images (no <img>, no remote requests): alt text is shown instead', () => {
    const out = body('![tracking pixel](https://evil.example/p.png) and ![](x.png)');
    expect(out).not.toContain('<img');
    expect(out).toContain('[image: tracking pixel]');
    expect(out).toContain('[image: untitled]');
  });

  it('escapes attribute-breaking characters in code language hints and link targets', () => {
    expect(body('```"><script>x</script>\ncode\n```')).not.toContain('<script');
    expect(body('[a](https://x.co/"onmouseover="y)')).not.toContain('onmouseover="y"');
  });

  it('allows only http(s), mailto and anchors in safeHref', () => {
    expect(safeHref('https://a.co')).toBe('https://a.co');
    expect(safeHref(' http://a.co/x ')).toBe('http://a.co/x');
    expect(safeHref('mailto:a@b.co')).toBe('mailto:a@b.co');
    expect(safeHref('#top')).toBe('#top');
    for (const bad of ['', 'javascript:1', 'https://', 'a b', 'https://a.co/\u0000', 'data:,x', '#a b']) {
      expect(safeHref(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('Markdown robustness', () => {
  it('parses a large document quickly', () => {
    const doc = Array.from({ length: 3000 }, (_, i) => `## Heading ${i}\n\nSome **bold** and *italic* text with a [link](https://x.co/${i}) and \`code\`.\n\n- item\n- item`).join('\n\n');
    const t0 = performance.now();
    const blocks = parseMarkdown(doc);
    expect(blocks.length).toBe(9000);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('does not blow up on pathological delimiters', () => {
    const t0 = performance.now();
    for (const s of ['*a '.repeat(4000), '_'.repeat(8000), '['.repeat(3000), '`'.repeat(5000), '**'.repeat(4000), '> '.repeat(500) + 'x']) {
      parseMarkdown(s);
    }
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});
