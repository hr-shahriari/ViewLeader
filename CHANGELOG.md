# Changelog

## Unreleased

### Removed

- `ViewLeaderOptions.selfDrive` and `ViewLeader.start()` / `stop()`. Call `update()` from your own render loop.
- `ViewLeaderOptions.documentLimits`. The shipped document limits are fixed.
- `PlacementMode` `'perimeter'`. `'sides'`, `'rows'` and `'auto'` remain.
- Error classes `DisposedError`, `DuplicateIdError`, `InvalidConfigurationError`, `InvalidInputError`, `InvariantViolationError` and `NotFoundError`. Those failures are thrown as plain `ViewLeaderError` and the `code` values (`DISPOSED`, `DUPLICATE_ID`, `INVALID_CONFIGURATION`, `INVALID_INPUT`, `INVARIANT_VIOLATION`, `NOT_FOUND`) are unchanged — match on `code`. `InvalidDocumentError`, `DocumentTooLargeError` and `AdapterError` remain classes.
- `EditingCancellationReason`; `editing.cancel()` takes no argument.
- Markup authoring raw session path: `begin()`, `commitRegion()`, `commitInk()`, the `MarkupAuthoringSession` export and `GeometryLimits` / `DEFAULT_GEOMETRY_LIMITS`. Use `start()`, `complete()` and `cancel()`. `MarkupAuthoringOptions` is now exported.
- Plugin `GroupPrimitive` (`kind: 'group'`) and `HitRegionPrimitive` (`kind: 'hit-region'`) from the `render` hook's primitives.
- `ExtensionRuntimeOptions.limits` / `.coreApiVersion` (never reachable from `ViewLeaderOptions`). Plugin `coreApiRange` accepts caret ranges only (`^1.0.0`).
- `ElementResolution.localId`.
- `NeutralViewerStateAdapter` alias; use `ViewerStateAdapter`.
- `LintOptions.minimumSegmentLength`.
- `viewleader/interchange`: `mergeIdentifiedDocuments`, `transactionalLoad`, `refreshElementFallbacksOnSave` and their types (`IdentifiedDocument`, `RefreshableRecord`, `ElementLikeAnchor`, `FallbackLookup`, `TransactionalDocumentTarget`, `DocumentLoadMode`, `DocumentLoadReport`).
- `BcfExportOptions.now`, `BcfParseOptions.inflateRaw` / `.archiveLimits` and `BcfApplyPlanOptions.existingViewIds`, plus the `ArchiveInflater` type and the `crc32` and `xmlElement` helpers. Deflate entries are inflated with the platform `DecompressionStream`.
- `viewleader/markdown`: `MarkdownPluginLimits`, `DEFAULT_MARKDOWN_PLUGIN_LIMITS` and `validateMarkdownSource`; `parseMarkdownPluginContent(source)` and `parseMarkdownPluginContentLoose(source)` no longer take a limits argument.
- `viewleader/react` and `viewleader/vue`: `StyleEditorLabels` and `StyleEditorOptions`; `useStyleEditor(leader)` and `new StyleEditor(host)` take no label options.
- `npm run perf:gate` and `scripts/performance-gate.mjs`; `npm run perf:browser` exits non-zero on a budget miss itself. `scripts/serve-demo-dist.mjs` is gone; Playwright always serves the demo through `vite preview`.

### Changed

- `ViewLeader.views` is the saved-view coordinator itself. `views.subscribe()` fires on saved-view, tour and activation changes only, not on every runtime change.
