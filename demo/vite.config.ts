import {defineConfig} from 'vite';
import {resolve} from 'node:path';
import { fileURLToPath } from 'node:url';
export default defineConfig({root: ".", 
    resolve:
    {
        alias:
        {
            viewleader: fileURLToPath(new URL('../src/index.ts', import.meta.url))
        },
        dedupe: ['three']
    },
    
    server: {port: 3000, open: false}
})
