// import { defineConfig } from 'vite';
// import dts from 'vite-plugin-dts';
// import { resolve } from 'path';

// export default defineConfig({
//     plugins: [
//         dts({
//             insertTypesEntry: true,
//             rollupTypes: true,
//         }),
//     ],
//     build: {
//         lib: {
//             entry: resolve(__dirname, 'src/index.ts'),
//             name: 'ViewLeader',
//             formats: ['es', 'cjs'],
//             fileName: (format) => `viewleader.${format === 'es' ? 'es' : 'cjs'}.js`,
//         },
//         rollupOptions: {
//             external: ['three'],
//             output: {
//                 globals: {
//                     three: 'THREE',
//                 },
//             },
//         },
//         sourcemap: true,
//     },
// });

import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'ViewLeader',
      fileName: 'viewleader',
      formats: ['es'],
    },
    rollupOptions: { external: ['three'] },
    sourcemap: true,
  },
});