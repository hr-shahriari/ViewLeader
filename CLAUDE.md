# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`viewleader` — an engine-neutral SVG annotation / leader-line overlay for 3D model viewers. The
library owns label placement and leader routing; the host viewer keeps owning the camera and the
model. Published as one npm package with six entry points (`.`, `/three`, `/react`, `/vue`,
`/markdown`, `/interchange`). The `demo/` workspace is both the example gallery and the fixture
source for the grading tests.

## Commands

```bash
npm run build            # tsup → dist/ (six entries, ESM + .d.ts)
npm run typecheck        # tsc --noEmit for src+test, then for demo. There is no ESLint — this is the lint.
npm test                 # vitest run (unit + integration)
npm run test:watch
npm run dev:demo         # vite dev server on 127.0.0.1:4173
npm run build:demo
npm run test:e2e         # playwright, chromium + webkit, builds and previews the demo itself
npm run check            # the full gate, in order: typecheck → build → test → build:demo → test:e2e
```

Single test file / single case:

```bash
npx vitest run test/v1-routing-mode.test.ts
npx vitest run -t 'dogleg'
npx playwright test e2e/examples.spec.ts --project=chromium -g 'Markup'
```

**`npm test` needs `dist/` to exist.** `test/v1-package-boundary.test.ts` walks the built
declaration graph to prove the bare entry never pulls in Three or IFC types. Run `npm run build`
first, or that test fails on a clean checkout. This is why `check` orders build before test.

Performance is a separate, opt-in gate — `npm run perf:browser` builds the library and the demo,
runs the scenarios in `scripts/run-browser-performance.mjs` in Playwright's Chromium against the
demo's `vite preview`, writes the JSON report (`--output=<path>`, default
`artifacts/performance-results.json`) and exits non-zero when any scenario's median-run p95 is over
its budget. `--scenario=<id>` runs one. It does not run in `check`.

## Architecture

### The seam: adapters, not engines

`HostAdapterBundle` in [src/host.ts](src/host.ts) is the only thing the core knows about the outside
world. Only `projection` is required; `elements`, `tagText`, `picking`, `surfacePicking`,
`occlusion`, `modelBounds`, `interaction`, `images` and `viewerState` are optional and each
degrades gracefully. Everything crossing the seam is plain data (`Vec2`/`Vec3`/`Rect` in
[src/types.ts](src/types.ts)) — no engine types. `src/three/` is one implementation of the bundle
and is the *only* place allowed to name Three; the boundary test enforces that.

### Facade → runtime → engines

- [src/view-leader.ts](src/view-leader.ts) — the `ViewLeader` class. Pure facade: it groups the API
  into capability objects (`annotations`, `authoring`, `documents`, `history`, `definitions`,
  `views`, `diagnostics`, `geometry`, `editing`) and delegates. Anything not re-exported from
  [src/index.ts](src/index.ts) is internal and free to change.
- [src/runtime.ts](src/runtime.ts) — `ViewLeaderRuntime`, the frame loop and the owner of transient
  state (selection, hover, previews, layout frame, placement/routing mode, annotation scale).
- [src/document.ts](src/document.ts) — `DocumentEngine`: the persisted document, validation against
  `DocumentLimits`, transactions and undo/redo. `edit()` opens an implicit transaction; nested
  `edit()` calls collapse into the enclosing one so a compound operation is one undo step.

### The frame pipeline

`runtime.update()` is the whole render, and reading it top to bottom is the fastest way to
understand this codebase. Per frame:

1. Skip entirely unless the projection revision changed or something invalidated the render.
2. Per annotation: merge style overrides (document override, then active saved-view override),
   resolve the style, lay out content (built-in via memoized `#layoutBuiltInCached`, or through the
   plugin's `render` hook), project every leg's anchor. Legs whose anchors are off-screen drop out.
3. Placement — one path only: [src/labelPlacer.ts](src/labelPlacer.ts) rails labels *outside* a
   frame (drawn rect → projected model AABB → last valid → the anchors' own cloud), then
   [src/separation.ts](src/separation.ts) pushes overlaps apart, then the optional
   `strategies.snap` hook adjusts.
4. Routing — [src/routing.ts](src/routing.ts) with every *other* placed label as an obstacle.
5. Occlusion — [src/occlusion.ts](src/occlusion.ts), if the host supplied the adapter.
6. `SvgOverlay.render()` in [src/render.ts](src/render.ts) writes the SVG.

Two invariants recur in the comments and should be preserved: **no swimming** (a leader's shape or a
label's home must not change because unrelated annotations entered or left the frustum — hence the
document-wide `candidateCount` and the placement hysteresis), and **live previews beat stored
state** (an in-progress drag overrides both the annotation's own placement and any view override,
and only becomes stored on release).

The host drives it: call `update()` from its own render loop. There is no self-driven rAF loop.

### Other subsystems worth knowing

- [src/extensions.ts](src/extensions.ts) — plugin runtime. Plugins declare `coreApiRange`,
  `schemaVersion`, `validate`, `migrations`, a `render` hook returning declarative primitives, and
  tools. [src/markdown/](src/markdown/) is the reference plugin and ships as its own entry point.
- [src/definitions.ts](src/definitions.ts) + [src/theme.ts](src/theme.ts) — styles, terminators,
  enclosures, templates. Sizes are written in **paper millimetres and CAD pen weights**, converted
  to pixels by `mm()`/`lineweight()`, so every constant is checkable against a published drafting
  standard instead of being a magic number. Two palettes: `CAD_PAPER`, `CAD_DARK`.
- [src/lint.ts](src/lint.ts) — drafting-standards lint over a laid-out frame (ASME Y14.2 /
  ISO 128-22 / ISO 3098). Each rule cites its clause.
- [src/saved-views/](src/saved-views/) — engine-neutral camera/visibility state, saved views and
  linear tours. `neutral-types.ts` is a hard boundary: no engine, control or loader type crosses it.
- [src/interchange/](src/interchange/) — BCF 2.1 read/write plus the archive and XML plumbing.
- [src/react/](src/react/), [src/vue/](src/vue/) — thin bindings. Each builds one `ViewLeader` per
  mounted boundary *element* and disposes it when the element goes, so a re-render cannot leak a
  second overlay. The framework-agnostic controllers both entries hand to a host are re-exported
  once from [src/internal/host-toolkit.ts](src/internal/host-toolkit.ts).

## Conventions

- TypeScript is strict with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. That is why
  optional fields are built with the conditional-spread idiom (`...(x === undefined ? {} : { x })`)
  rather than assigning `undefined`, and why indexed reads carry `!` or a guard. Match it.
- ESM only, `.js` extensions on relative imports.
- Tests import the package the way a consumer does (`from 'viewleader'`, `'viewleader/three'`);
  vitest and tsconfig alias those to `src/` so the suite runs without a build.
- Tuned constants keep the paragraph explaining why they hold that value. A tuned number without its
  reason is indistinguishable from a guess — don't strip those comments.
- `ponytail:` comments mark deliberate simplifications and name the upgrade path.
- Errors are the classes in [src/errors.ts](src/errors.ts); match on `code`, never on message text.

### Test fixtures are oracles

`test/crowded-scene-harness.ts` (scene A) and `test/adversarial-scene-harness.ts` (scene B) are
fixed, deterministic scenes that several tests grade layout quality against — overlap counts,
leader crossings, anti-swim over a 36-step orbit, plus a pinned plan snapshot in
`test/snapshots/`. They build from `demo/src/shared/`, so the demo and the graded scenes cannot
drift apart. Changing a placement or routing heuristic will move these numbers; that is the point —
re-grade deliberately, don't retune the fixture to match the new output.

### The demo gallery has one list

[demo/src/examples.ts](demo/src/examples.ts) (`EXAMPLES`) is the single registry consumed by
`demo/vite.config.ts` (Rollup inputs and the View-source plugin), `test/examples-routes.test.ts` and
`e2e/examples.spec.ts`. Adding an example means: a row there, `demo/<dir>/index.html`,
`demo/src/pages/<source>`, and a hand-written entry in `demo/index.html`. Example pages set
`data-vl-ready="1"` on `<body>` after the first annotation frame — the e2e suite waits on that.
