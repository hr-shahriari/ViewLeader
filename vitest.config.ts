import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const entry = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests import the package the way a user does, but resolve to source rather than `dist`, so
    // the suite runs from a clean checkout without a build step and reports failures at real lines.
    //
    // Subpaths are listed first on purpose: alias keys match by prefix, so a bare `viewleader` entry
    // placed above them would capture `viewleader/three` and rewrite it to a path that is not there.
    alias: {
      'viewleader/three': entry('./src/three/index.ts'),
      'viewleader/react': entry('./src/react/index.ts'),
      'viewleader/vue': entry('./src/vue/index.ts'),
      'viewleader/markdown': entry('./src/markdown/index.ts'),
      viewleader: entry('./src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: { reporter: ['text', 'json-summary'] },
  },
});
