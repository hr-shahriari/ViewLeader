import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

import { EXAMPLES } from './src/examples.js';

const page = (dir: string): string => resolve(import.meta.dirname, dir, 'index.html');
const PAGES = resolve(import.meta.dirname, 'src/pages');

/**
 * Makes the "View source" links work — 14 in the gallery index and one per example shell.
 *
 * They pointed straight at `/src/pages/<name>.ts`, which was broken in both directions: the dev
 * server transforms that path and hands back compiled JavaScript, and the build never emits it at
 * all (Rollup emits what the bundle imports, and a file referenced from an `<a href>` is not an
 * import), so every one of them 404'd in the built gallery that `npm run preview` serves.
 *
 * Served as `.txt` rather than `.ts` on purpose: `.ts` is registered as `video/mp2t` in most MIME
 * databases, so browsers download it instead of showing it. `.txt` displays inline everywhere.
 */
function exampleSources(): Plugin {
  const SUFFIX = /^\/src\/pages\/([\w.-]+)\.txt$/u;
  return {
    name: 'viewleader-example-sources',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const match = SUFFIX.exec((request.url ?? '').split('?')[0] ?? '');
        const source = EXAMPLES.find((example) => example.source === match?.[1])?.source;
        if (source === undefined) {
          next();
          return;
        }
        readFile(resolve(PAGES, source), 'utf8').then(
          (text) => {
            response.setHeader('Content-Type', 'text/plain; charset=utf-8');
            response.end(text);
          },
          next,
        );
      });
    },
    async generateBundle() {
      for (const { source } of EXAMPLES) {
        this.emitFile({
          type: 'asset',
          fileName: `src/pages/${source}.txt`,
          source: await readFile(resolve(PAGES, source), 'utf8'),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [exampleSources()],
  server: { host: '127.0.0.1', port: 4173 },
  preview: { host: '127.0.0.1', port: 4173 },
  build: {
    // Examples use top-level await for readable sequencing (save a view, move the camera, save another).
    target: 'esnext',
    // Build the gallery and every example as a real multi-page app. Without an explicit input list
    // Vite emits only the gallery index and silently drops the example pages.
    rollupOptions: {
      input: {
        gallery: resolve(import.meta.dirname, 'index.html'),
        performance: resolve(import.meta.dirname, 'performance.html'),
        ...Object.fromEntries(EXAMPLES.map(({ input, dir }) => [input, page(dir)])),
      },
    },
  },
});
