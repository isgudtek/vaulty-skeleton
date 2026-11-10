import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const USE_CLIENT = '"use client";\n';

/**
 * Bundlers strip module-level directives (Rollup warns "use client ... was ignored"), so re-insert
 * `"use client"` at the very top of the built React entry for Next.js App Router / RSC. The source map is
 * shifted by exactly one line (a leading `;` in `mappings`), so stack traces stay accurate.
 * Only the React entry is marked: `@vaulty/core` itself has no React and stays usable from server code.
 */
function markReactEntryAsClient(): void {
  for (const file of ['dist/react.js', 'dist/react.cjs']) {
    if (!existsSync(file)) continue;
    const code = readFileSync(file, 'utf8');
    if (code.startsWith(USE_CLIENT)) continue;
    writeFileSync(file, USE_CLIENT + code);
    const mapFile = `${file}.map`;
    if (existsSync(mapFile)) {
      const map = JSON.parse(readFileSync(mapFile, 'utf8')) as { mappings: string };
      map.mappings = `;${map.mappings}`;
      writeFileSync(mapFile, JSON.stringify(map));
    }
  }
}

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    react: 'src/react/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  target: 'es2022',
  platform: 'neutral',
  // react / react-dom are OPTIONAL peer dependencies; they (and the JSX runtime) must never be bundled.
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
  async onSuccess() {
    markReactEntryAsClient();
  },
});
