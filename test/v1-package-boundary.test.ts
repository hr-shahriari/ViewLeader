import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';

describe('viewleader export allowlist', () => {
  it('does not publish mutable engines, host caches, renderer plans, or legacy managers', () => {
    const exports = Object.keys(core);
    expect(exports).not.toContain('DocumentEngine');
    expect(exports).not.toContain('HostIntegration');
    expect(exports).not.toContain('SvgOverlay');
    expect(exports).not.toContain('ExtensionRuntime');
    expect(exports).not.toContain('DefinitionsCapability');
    expect(exports).not.toContain('FramePlan');
    expect(exports).not.toContain('Manager');
    expect(exports).not.toContain('routing');
    expect(exports).not.toContain('markup');
    expect(exports).not.toContain('markdownPlugin');
  });

  it('keeps the built core declaration boundary free of Three and IFC types', async () => {
    // Walks the declaration graph `import 'viewleader'` actually reaches. tsup splits the shared
    // engine into content-hashed chunks, so reading `index.d.ts` alone would pass trivially — it is
    // barely more than a list of re-exports. The Three adapter lives behind `viewleader/three` and
    // is allowed to name Three; the point is that the bare entry never drags those types in.
    const reached = new Set<string>();
    const visit = async (file: URL): Promise<string> => {
      if (reached.has(file.href)) return '';
      reached.add(file.href);
      const text = await readFile(file, 'utf8');
      const chunks = [...text.matchAll(/from ['"](\.\/[\w.-]+)\.js['"]/gu)];
      const nested = await Promise.all(
        chunks.map(async (match) => visit(new URL(`${match[1]}.d.ts`, file))),
      );
      return text + nested.join('');
    };

    const source = await visit(new URL('../dist/index.d.ts', import.meta.url));
    // The type surface, not the prose. `tsup --dts` copies source JSDoc into the declaration file
    // verbatim, and the axis-remap doc in `interchange/bcf.ts` has to say "IFC" and "three.js" to
    // explain which convention maps to which — naming a foreign convention in a comment is not the
    // same as importing its types, and the second assertion below matched on the word alone.
    const declarations = source.replace(/\/\*[\s\S]*?\*\//gu, '');
    expect(declarations).not.toMatch(/from ['"]three['"]/u);
    expect(declarations).not.toMatch(/\b(?:WebGLRenderer|THREE|IFC)\b/u);
  });
});
