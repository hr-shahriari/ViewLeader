import { defineConfig } from 'tsup';

// One package, five entry points. The adapters (three/react/vue) and the markdown plugin are
// separate entries rather than separate packages so a user installs one thing and imports only the
// parts they need — an app with no React never pulls the React binding into its bundle.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    three: 'src/three/index.ts',
    react: 'src/react/index.ts',
    vue: 'src/vue/index.ts',
    markdown: 'src/markdown/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // Entries share the core engine; splitting emits it once instead of copying it into all five.
  splitting: true,
  treeshake: true,
  // Optional peers. Bundling them would ship a second copy of the host app's React or Three.
  external: ['three', 'react', 'vue'],
});
