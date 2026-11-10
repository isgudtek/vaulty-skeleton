import { type ReactNode, createElement, memo, useMemo } from 'react';
import { type Block, type Inline, parseMarkdown } from '../lib/markdown';

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return n.v;
      case 'strong':
        return <strong key={i}>{renderInline(n.c)}</strong>;
      case 'em':
        return <em key={i}>{renderInline(n.c)}</em>;
      case 'del':
        return <del key={i}>{renderInline(n.c)}</del>;
      case 'code':
        return <code key={i}>{n.v}</code>;
      case 'br':
        return <br key={i} />;
      case 'link':
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow">
            {renderInline(n.c)}
          </a>
        );
    }
  });
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.t) {
    case 'heading':
      return createElement(`h${b.level}`, { key }, renderInline(b.c));
    case 'p':
      return <p key={key}>{renderInline(b.c)}</p>;
    case 'code':
      return (
        <pre key={key} data-lang={b.lang || undefined}>
          <code>{b.v}</code>
        </pre>
      );
    case 'quote':
      return <blockquote key={key}>{b.c.map(renderBlock)}</blockquote>;
    case 'hr':
      return <hr key={key} />;
    case 'ul':
    case 'ol': {
      const items = b.items.map((item, i) => (
        <li key={i} className={item.checked === null ? undefined : 'task'}>
          {item.checked === null ? null : (
            <input type="checkbox" checked={item.checked} readOnly disabled aria-label={item.checked ? 'Done' : 'To do'} className="mr-2 accent-indigo-600" />
          )}
          {renderInline(item.c)}
        </li>
      ));
      return b.t === 'ul' ? (
        <ul key={key}>{items}</ul>
      ) : (
        <ol key={key} start={b.start}>
          {items}
        </ol>
      );
    }
  }
}

/** Live Markdown preview. Renders a typed tree as React elements — never `innerHTML`. */
export const Preview = memo(function Preview({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="md" data-testid="preview">
      {blocks.length === 0 ? (
        <p className="italic text-ink-soft">Your rendered note appears here.</p>
      ) : (
        blocks.map(renderBlock)
      )}
    </div>
  );
});
