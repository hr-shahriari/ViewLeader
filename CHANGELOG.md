# Changelog

## Unreleased

### Removed

- `ViewLeaderOptions.selfDrive` and `ViewLeader.start()` / `stop()`. Call `update()` from your own render loop.
- `ViewLeaderOptions.documentLimits`. The shipped document limits are fixed.
- `PlacementMode` `'perimeter'`. `'sides'`, `'rows'` and `'auto'` remain.
- Error classes `DisposedError`, `DuplicateIdError`, `InvalidConfigurationError`, `InvalidInputError`, `InvariantViolationError` and `NotFoundError`. Those failures are thrown as plain `ViewLeaderError` and the `code` values (`DISPOSED`, `DUPLICATE_ID`, `INVALID_CONFIGURATION`, `INVALID_INPUT`, `INVARIANT_VIOLATION`, `NOT_FOUND`) are unchanged — match on `code`. `InvalidDocumentError`, `DocumentTooLargeError` and `AdapterError` remain classes.
- `EditingCancellationReason`; `editing.cancel()` takes no argument.
- Markup authoring raw session path: `begin()`, `commitRegion()`, `commitInk()`, the `MarkupAuthoringSession` export and `GeometryLimits` / `DEFAULT_GEOMETRY_LIMITS`. Use `start()`, `complete()` and `cancel()`. `MarkupAuthoringOptions` is now exported.
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
- `annotations.keynotes()` orders keys with `Intl.Collator('en', { numeric: true })`: letters compare case-insensitively first (`a1` before `B1`; code-point order put `B1` first), and two spellings of the same number are ordered by plain string (`A09` before `A9`; previously the shorter spelling came first).
