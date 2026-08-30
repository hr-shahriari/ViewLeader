import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXAMPLES } from '../demo/src/examples.js';
import demoConfig from '../demo/vite.config.js';

// The examples app is a multi-page gallery: one directory + one self-contained source file per example.
// This test keeps the gallery index, the per-example HTML shells, the source pages, and the Vite inputs
// in agreement so a broken link or a dropped build input fails here instead of shipping a 404.
//
// The example list itself now lives in `demo/src/examples.ts`, which the Vite config and the
// Playwright suite both import. It used to be re-declared here and again in `e2e/examples.spec.ts`,
// and the two copies drifted — the e2e list gained the leader editor while the gallery and the Vite
// config still had thirteen entries, so `npm run check` failed from a clean checkout on a count
// assertion nothing in this file could see.
const demo = resolve(process.cwd(), 'demo');

const exists = async (path: string): Promise<boolean> =>
  access(resolve(demo, path)).then(() => true, () => false);

describe('examples gallery', () => {
  it('links every example from the gallery index, in order', async () => {
    const index = await readFile(resolve(demo, 'index.html'), 'utf8');
    // `%BASE_URL%`, not a leading `/`: GitHub Pages serves a project repo from a subpath, so the
    // hand-written links carry Vite's base placeholder, which resolves to `/` for every local
    // command and to `/ViewLeader/` in the deploy workflow. The contract this asserts is unchanged —
    // one gallery row per manifest entry, in order — only the prefix it skips over.
    const linked = [...index.matchAll(/<h2><a href="%BASE_URL%([^/"]+)\/">([^<]+)<\/a>/gu)];
    expect(linked.map((match) => match[1])).toEqual(EXAMPLES.map((example) => example.dir));
    // The label too: `e2e/examples.spec.ts` asserts this text against the same list at runtime, and
    // catching a rename here costs milliseconds instead of a browser launch. `&` is escaped in the
    // markup and decoded by the browser, so it is decoded here as well — four labels contain one.
    const text = (value: string): string => value.replaceAll('&amp;', '&');
    expect(linked.map((match) => text(match[2] ?? ''))).toEqual(EXAMPLES.map((example) => example.label));
  });

  it('ships an HTML shell and a source page for each example', async () => {
    for (const example of EXAMPLES) {
      expect(await exists(`${example.dir}/index.html`), example.dir).toBe(true);
      expect(await exists(`src/pages/${example.source}`), example.source).toBe(true);
      const html = await readFile(resolve(demo, example.dir, 'index.html'), 'utf8');
      expect(html, example.dir).toContain(`/src/pages/${example.source}`);
    }
  });

  it('registers every example as a Vite build input', () => {
    // Reads the resolved config rather than grepping its text. The old form asserted that
    // `vite.config.ts` contained the literal string `'<dir>'`, which a comment would have satisfied
    // and which stopped meaning anything once the inputs were derived from `EXAMPLES`.
    const input = (demoConfig as { build?: { rollupOptions?: { input?: Record<string, string> } } })
      .build?.rollupOptions?.input;
    expect(input).toBeTypeOf('object');
    for (const example of EXAMPLES) {
      expect(input?.[example.input], example.dir).toBe(resolve(demo, example.dir, 'index.html'));
    }
    // The gallery itself and the performance page are inputs too, and neither is an example.
    expect(input?.['gallery']).toBe(resolve(demo, 'index.html'));
    expect(input?.['performance']).toBe(resolve(demo, 'performance.html'));
  });

  it('imports only the public packages, never library source paths', async () => {
    for (const example of EXAMPLES) {
      const source = await readFile(resolve(demo, 'src/pages', example.source), 'utf8');
      expect(source, example.source).not.toMatch(/\.\.\/\.\.\/\.\.\/src\//);
      expect(source, example.source).toMatch(/viewleader/);
    }
  });
});
