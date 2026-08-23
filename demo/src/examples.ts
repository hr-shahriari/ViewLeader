/**
 * The gallery, once. Every example used to be registered in six places — the index page, the Vite
 * input list, its HTML shell, its source module, `test/examples-routes.test.ts` and
 * `e2e/examples.spec.ts` — and the two test files each carried their own hand-maintained copy of the
 * same fourteen rows.
 *
 * That drifted, exactly as you would expect: `e2e/examples.spec.ts` was committed listing the leader
 * editor while the gallery, the Vite config and the routes test still listed thirteen examples, so
 * `npm run check` failed from a clean checkout on a count assertion. One list means that particular
 * failure cannot happen again.
 *
 * `index.html` stays hand-written — it is the gallery's own copy, and prose belongs in prose. The
 * routes test checks it against this list rather than generating it.
 */
export interface ExampleRoute {
  /** Directory under `demo/`, which is also the URL path: `/hello-world/`. */
  readonly dir: string;
  /** Module under `demo/src/pages/`, including the extension — `react` is `.tsx`. */
  readonly source: string;
  /** Heading text in the gallery index, asserted verbatim by the e2e suite. */
  readonly label: string;
  /** Rollup input name in `vite.config.ts`. */
  readonly input: string;
}

export const EXAMPLES: readonly ExampleRoute[] = [
  { dir: 'hello-world', source: 'hello-world.ts', label: 'Hello world', input: 'helloWorld' },
  { dir: 'three-anchoring', source: 'three-anchoring.ts', label: 'Element anchoring', input: 'elementAnchoring' },
  { dir: 'ifc-lifecycle', source: 'ifc-lifecycle.ts', label: 'Model reload & recovery', input: 'modelReload' },
  { dir: 'rich-content', source: 'rich-content.ts', label: 'Rich content & routing', input: 'richContent' },
  { dir: 'markup', source: 'markup.ts', label: 'Markup & multi-leaders', input: 'markup' },
  { dir: 'plugin-anatomy', source: 'plugin-anatomy.ts', label: 'Plugin anatomy', input: 'pluginAnatomy' },
  { dir: 'react', source: 'react.tsx', label: 'React workflow', input: 'react' },
  { dir: 'vue', source: 'vue.ts', label: 'Vue workflow', input: 'vue' },
  { dir: 'saved-views', source: 'saved-views.ts', label: 'Saved views & tours', input: 'savedViews' },
  { dir: 'workbench', source: 'workbench.ts', label: 'Workbench', input: 'workbench' },
  { dir: 'drafting-styles', source: 'drafting-styles.ts', label: 'Drafting styles', input: 'draftingStyles' },
  { dir: 'host-chrome', source: 'host-chrome.ts', label: 'Host chrome', input: 'hostChrome' },
  { dir: 'direct-editing', source: 'direct-editing.ts', label: 'Direct editing', input: 'directEditing' },
  { dir: 'leader-editor', source: 'leader-editor.ts', label: 'Leader editor', input: 'leaderEditor' },
  { dir: 'bcf', source: 'bcf.ts', label: 'BCF 2.1 round trip', input: 'bcf' },
  { dir: 'occlusion', source: 'occlusion.ts', label: 'Occlusion & hidden legs', input: 'occlusion' },
];
