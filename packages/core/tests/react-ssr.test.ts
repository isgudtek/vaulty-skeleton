// @vitest-environment node
/**
 * Server-side rendering safety for `@vaulty/core/react` (Next.js / Remix / any SSR).
 * Runs in plain Node: there is no `document`, `window`, `navigator.storage` or `indexedDB`.
 */
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PatternGrid, useVault, useVaultDialog } from '../src/react';

describe('@vaulty/core/react on the server', () => {
  it('really is a DOM-less environment', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
  });

  it('server-renders a component using useVaultDialog() + <VaultModal /> without touching browser APIs', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Page() {
      const { VaultModal, isUnlocked } = useVaultDialog();
      return h('main', null, h('p', null, isUnlocked ? 'unlocked' : 'locked'), h(VaultModal));
    }
    const html = renderToString(h(Page));
    expect(html).toBe('<main><p>locked</p></main>'); // modal is closed on the server: renders nothing
    expect(errors).not.toHaveBeenCalled(); // no useLayoutEffect / hydration warnings
    errors.mockRestore();
  });

  it('server-renders useVault() and <PatternGrid />', () => {
    function Lock() {
      const vault = useVault();
      return h('div', null, vault.status, h(PatternGrid, { size: 200 }));
    }
    const html = renderToString(h(Lock));
    expect(html).toContain('locked');
    expect(html.match(/data-node=/g)).toHaveLength(25);
  });
});
