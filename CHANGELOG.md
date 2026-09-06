# Changelog

## Unreleased

### Added

- `setPlacementMode('quadrants')` organizes automatic leader lines with short side exits and ordered top/bottom escape lanes, checking full routes against labels and other leaders.
- `setKeepLabelsOutsideModel(true)` keeps entire labels outside the current projected model bounds at close zoom, allowing off-screen placement without changing authored positions. The optional `ProjectionAdapter.projectBounds` capability supports safe bounds projection; the Three adapter includes near-plane clipping.
- Model-aware organization example, layout and outside-only controls in Leader Editor and Workbench, and coverage for mirrored routing, camera intersections, close zoom, and authored-state preservation.
- IFC Studio enables quadrant routing and outside-only placement after model load, with inspector controls and fit, side, and rear views of the full IFC model.

### Removed

- `ViewLeaderOptions.selfDrive` and `ViewLeader.start()` / `stop()`. Call `update()` from your own render loop.
- `ViewLeaderOptions.documentLimits`. The shipped document limits are fixed.
- `PlacementMode` `'perimeter'`. `'sides'`, `'rows'` and `'auto'` remain.
- Error classes `DisposedError`, `DuplicateIdError`, `InvalidConfigurationError`, `InvalidInputError`, `InvariantViolationError` and `NotFoundError`. Those failures are thrown as plain `ViewLeaderError` and the `code` values (`DISPOSED`, `DUPLICATE_ID`, `INVALID_CONFIGURATION`, `INVALID_INPUT`, `INVARIANT_VIOLATION`, `NOT_FOUND`) are unchanged — match on `code`. `InvalidDocumentError`, `DocumentTooLargeError` and `AdapterError` remain classes.
- `EditingCancellationReason`; `editing.cancel()` takes no argument.
- Markup authoring raw session path: `begin()`, `commitRegion()`, `commitInk()`, the `MarkupAuthoringSession` export and `GeometryLimits` / `DEFAULT_GEOMETRY_LIMITS`. Use `start()`, `complete()` and `cancel()`. `MarkupAuthoringOptions` is now exported.
- `MarkupAuthoringOptions.assertActive`. It wired the `ViewLeader` facade guard; directly constructed capabilities still guard their own lifecycle.
- `MarkupAuthoringCapability.retargetAnchor()`, `.setLegRoute()` and `.reorderAnchor()`. Use `annotations.retargetLeg()` and `annotations.rerouteLeg()`; reorder legs with `annotations.update(id, { anchors })`.
- The `limits` argument of the markup geometry helpers `validateRegionAnchor`, `createRegionAnchor`, `moveRegion`, `resizeRegion`, `retargetRegion`, `addRegionVertex`, `moveRegionVertex`, `removeRegionVertex`, `createInk`, `validateInk`, `simplifyInk`, `moveInk`, `replaceInkPoints` and `editInkPoint`. The argument after it moves up one position: `createRegionAnchor(plane, geometry, modelId?)` and `validateInk(ink, unrecognized?)`.
- `AuthoringSnapshot.sessionId`, `MarkupAuthoringSnapshot.sessionId` and `MarkupAuthoringSnapshot.status`. `authoring.markup.establishPlane()`, `setRegionGeometry()` and `appendInkPoint()` take no `source` argument; it only fed the status text.
- `definitions.applyTemplateToAnnotation()`. Use `annotations.update(id, definitions.applyTemplate({}, templateId))`.
- Plugin `GroupPrimitive` (`kind: 'group'`) and `HitRegionPrimitive` (`kind: 'hit-region'`) from the `render` hook's primitives.
- `ExtensionRuntimeOptions.limits` / `.coreApiVersion` (never reachable from `ViewLeaderOptions`). Plugin `coreApiRange` accepts caret ranges only (`^1.0.0`).
- `ElementResolution.localId`.
- `NeutralViewerStateAdapter` alias; use `ViewerStateAdapter`.
- `LintOptions.minimumSegmentLength`.
- `viewleader/interchange`: `mergeIdentifiedDocuments`, `transactionalLoad`, `refreshElementFallbacksOnSave` and their types (`IdentifiedDocument`, `RefreshableRecord`, `ElementLikeAnchor`, `FallbackLookup`, `TransactionalDocumentTarget`, `DocumentLoadMode`, `DocumentLoadReport`).
- `BcfExportOptions.now`, `BcfParseOptions.inflateRaw` / `.archiveLimits` and `BcfApplyPlanOptions.existingViewIds`, plus the `ArchiveInflater` type and the `crc32`, `xmlElement`, `exportAxis` and `importAxis` helpers. Deflate entries are inflated with the platform `DecompressionStream`.
- `viewleader/markdown`: `MarkdownPluginLimits`, `DEFAULT_MARKDOWN_PLUGIN_LIMITS` and `validateMarkdownSource`; `parseMarkdownPluginContent(source)` and `parseMarkdownPluginContentLoose(source)` no longer take a limits argument.
- `viewleader/react` and `viewleader/vue`: `StyleEditorLabels` and `StyleEditorOptions`; `useStyleEditor(leader)` and `new StyleEditor(host)` take no label options.
- `viewleader/react` and `viewleader/vue`: `HandleEntry.legId`, `.slot` and `.index`. `entry.key` identifies a handle; `entry.target.leg` names the leg of a `'handle'` or `'route-handle'` entry and `entry.target.index` its ordinal. A region handle's leg is no longer published.
- `npm run perf:gate` and `scripts/performance-gate.mjs`; `npm run perf:browser` exits non-zero on a budget miss itself. `scripts/serve-demo-dist.mjs` is gone; Playwright always serves the demo through `vite preview`.

### Changed

- `ViewLeader.views` is the saved-view coordinator, behind the same disposed guard as every other capability. `views.subscribe()` fires on saved-view, tour and activation changes only, not on every runtime change.
- Starting built-in authoring with invalid plugin content leaves an active markup or plugin authoring tool running; validation now finishes before the existing tool is preempted.
- `annotations.keynotes()` orders keys with `Intl.Collator('en', { numeric: true })`: letters compare case-insensitively first (`a1` before `B1`; code-point order put `B1` first), and two spellings of the same number are ordered by plain string (`A09` before `A9`; previously the shorter spelling came first).

### Fixed

- Small camera movements no longer toggle doglegs between text baselines or reorder near-equal anchors into distant label slots. Single leaders and multileaders share attachment hysteresis, and automatic and quadrant placement retain feasible ordering through temporary offscreen frames. Document replacement clears this transient memory.
- Organized escape lines join the styled label landing without a small vertical jog. Crowded anchors near a model edge during rotation use compact exterior side routes while deeper anchors retain quadrant escapes.
- The organization example uses surface anchors and model occlusion to fade and dash hidden leaders while keeping labels readable, with a side-view control and real-camera orbit regressions.
- Plugin authoring wraps interaction lease acquisition failures as `ADAPTER_ERROR` and clones drafts before acquiring, so an uncloneable draft cannot leak a lease.
