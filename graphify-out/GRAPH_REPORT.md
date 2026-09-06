# Graph Report - .  (2026-09-01)

## Corpus Check
- 214 files · ~269,107 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2978 nodes · 7744 edges · 153 communities (135 shown, 18 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 103 edges (avg confidence: 0.73)
- Token cost: 116,499 input · 0 output

## Community Hubs (Navigation)
- Plugin Extension Runtime
- Definition Registry Internals
- Public Snapshot Types
- Markup Geometry Core
- Template Draft Capture
- Saved View Coordinator
- Saved View Activation State
- ViewLeader Facade
- Handle Editing Port
- Boundary Lifecycle
- Three.js Adapter Bundle
- React Binding Hooks
- TypeScript Build Config
- Demo Package Dependencies
- Inline Text Editing
- Tag Text Resolution
- Runtime Frame Loop
- Markup Authoring Capability
- Demo Example Pages
- Resolved Style Types
- Paper Millimetre Theme
- Style Editor
- BCF Interchange Codec
- Follow Registry
- Markdown Plugin
- Editing Controller
- Neutral Viewer State
- Render Primitives Cache
- Saved View Validation
- Graded Scene Harnesses
- Host Adapter Integration
- Content Markup Modules
- Text Editor Controller
- Label Placement
- SVG Overlay Writer
- Editing API Tests
- Framework Conformance Tests
- Authoring Session Types
- Annotative Scale Tests
- Document Normalization
- Occlusion Policy
- Demo Control Bar
- Drafting Standards Lint
- Demo Page Rationale
- Content Layout Engine
- Host Image Resolution
- Layout Frame Projection
- IFC Studio Demo
- Root Dev Dependencies
- Dogleg Routing Tests
- Document Engine Transactions
- Markup Annotation Drafts
- Demo TypeScript Config
- Performance Gate Scripts
- Projection Adapter
- Views Document Port
- Annotations Capability
- Example Registry Wiring
- Adversarial Scene Fixtures
- Authoring Controller
- Obstacle Aware Routing
- Document Schema Migrations
- Views Capability Tours
- Error Class Hierarchy
- Occluded Leg Tests
- BCF Apply Planner
- Zip Archive Plumbing
- Package Manifest Metadata
- Drag Hit Tolerance
- Interchange Document Ops
- Editing Keyboard Nudge
- Label Separation Insets
- Route Vertex Editing
- Package Entry Points
- Handles Tests
- Text Metrics Font Loading
- Vector Sheet Export
- Demo Performance Harness
- Region Ink Editing Tests
- IFC Web Worker
- Editing Hit Testing
- Leader Break Detour
- Region Ink Geometry
- Region Attachment Tests
- NPM Script Gate
- Document Compatibility Tests
- Drag Initiation API
- Vector Math Helpers
- Late Font Remeasure Tests
- Package Keywords
- Align And Distribute
- Built-in Content Fonts
- Document Serialization Limits
- Markup Authoring Session
- Three Adapter Tests
- Content Primitive Types
- Diagnostics Channel
- Frame Seam
- Forward Compatible Sections
- Build Gate Rationale
- React Demo Page
- Optional Peer Dependencies
- Markup Lifecycle Tests
- Annotative Scale Fixture
- Arrange Tests
- Editing Handle Tests
- Multi Point Authoring Tests
- Theme Option Tests
- Host Chrome Rationale
- Definition Reference Counts
- Adapter Subscriptions
- Document Residue Expansion
- Documents Capability
- Boundary Frame Memory
- Layout Frame Tests
- Editing Cursor Tests
- Marquee Selection Tests
- Route Grip Tests
- Snap Hook Tests
- Region Visibility Tests
- Style Override Tests
- README Integration Rationale
- README Export Rationale
- Ink Annotation CRUD
- Terminator Path Rendering
- Editing Drag Tests
- Placement Mode Inset Tests
- Drafting Convention Rationale
- Optional Peer Metadata
- History Coalescing Tests
- Performance Protocol Types
- Frame Persistence Tests
- Pages Deploy Workflow
- Core Architecture Invariants
- Leader Editor Demo
- Published Package Files
- Fan In Routing Tests
- Release Publish Workflow
- Demo Static Server
- Placement Mode Switch
- Overlay Hit Test Plan
- Three Viewer State Host
- Plan Snapshot Test
- Demo Env Types
- Demo Example Harness
- Mock Building Fixture
- XML Element Shim
- Crowded Scene Handle
- Code Style Conventions
- Error Code Matching

## God Nodes (most connected - your core abstractions)
1. `ViewLeader` - 120 edges
2. `Vec2` - 111 edges
3. `ViewLeaderRuntime` - 105 edges
4. `HostAdapterBundle` - 68 edges
5. `NormalizedPointerInput` - 62 edges
6. `AnnotationDraft` - 54 edges
7. `MarkupAuthoringCapability` - 51 edges
8. `SavedViewCoordinator` - 50 edges
9. `EditingController` - 49 edges
10. `DocumentEngine` - 48 edges

## Surprising Connections (you probably didn't know these)
- `Build before typecheck and test` --semantically_similar_to--> `npm run check full gate`  [INFERRED] [semantically similar]
  .github/workflows/release.yml → CLAUDE.md
- `definitionsFromCollections()` --indirect_call--> `definition()`  [INFERRED]
  src/definitions.ts → test/views-coordinator.test.ts
- `definitionsToCollections()` --indirect_call--> `definition()`  [INFERRED]
  src/definitions.ts → test/views-coordinator.test.ts
- `assertJson()` --indirect_call--> `key()`  [INFERRED]
  src/definitions.ts → test/v1-text-editor.test.ts
- `normalizeMetadata()` --indirect_call--> `key()`  [INFERRED]
  src/document.ts → test/v1-text-editor.test.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Shared example page shell (header, #viewport, module entry)** — demo_hello_world_index_page, demo_bcf_index_page, demo_direct_editing_index_page, demo_drafting_styles_index_page, demo_host_chrome_index_page, demo_ifc_lifecycle_index_page, demo_ifc_studio_index_page, demo_leader_editor_index_page [EXTRACTED 1.00]
- **Everything that requires dist/ before it can run** — _github_workflows_release_build_before_checks, _github_workflows_pages_deploy_demo_to_pages, claude_package_boundary_test, claude_check_gate [EXTRACTED 1.00]
- **Layout stability contract (invariants, pipeline, graded fixtures)** — claude_no_swimming_invariant, claude_live_previews_beat_stored_state, claude_frame_pipeline, claude_test_fixtures_as_oracles [EXTRACTED 1.00]
- **Demo gallery example page shells (registry-driven, one dir + one module each)** — demo_markup_index_markup_example, demo_occlusion_index_occlusion_example, demo_plugin_anatomy_index_plugin_anatomy_example, demo_react_index_react_example, demo_rich_content_index_rich_content_example, demo_saved_views_index_saved_views_example, demo_three_anchoring_index_three_anchoring_example, demo_vue_index_vue_example, demo_workbench_index_workbench_example [INFERRED 0.95]
- **Pinned third-party artifact provenance ledger** — demo_public_third_party_notices_web_ifc, demo_public_third_party_notices_inter_font, demo_public_models_notice_duplex_ifc_fixture, demo_public_third_party_notices_pinned_artifact_provenance [EXTRACTED 1.00]
- **Scene A layout oracle: railed labels, multi-leader, oversized plugin label, dogleg routes** — test_snapshots_scene_a_plan_scene_a_plan, test_snapshots_scene_a_plan_label_rail, test_snapshots_scene_a_plan_crowd_keynote, test_snapshots_scene_a_plan_crowd_markdown, test_snapshots_scene_a_plan_dogleg_route [EXTRACTED 1.00]

## Communities (153 total, 18 thin omitted)

### Community 0 - "Plugin Extension Runtime"
Cohesion: 0.06
Nodes (55): DefinitionBounds, domainError(), AccessibilityMetadata, apiRangeIncludes(), assertExactKeys(), callValidator(), canonicalJson(), clone() (+47 more)

### Community 1 - "Definition Registry Internals"
Cohesion: 0.05
Nodes (60): ANCHOR_TIP, applyTemplateDefaults(), assertExactKeys(), assertJson(), buildDefaultStyles(), BUILT_IN_DEFINITIONS, BUILT_IN_IDS, builtInDefinitions() (+52 more)

### Community 2 - "Public Snapshot Types"
Cohesion: 0.06
Nodes (58): AuthoringSnapshot, DefinitionsSnapshot, StyleOverride, DocumentLimits, TransactionOptions, EditingOptions, EditingSnapshot, SurfacePickingAdapter (+50 more)

### Community 3 - "Markup Geometry Core"
Cohesion: 0.10
Nodes (53): add2(), addAnnotationAnchor(), addRegionVertex(), clone(), closestOnSegment(), copyVec2(), createInk(), DEFAULT_GEOMETRY_LIMITS (+45 more)

### Community 4 - "Template Draft Capture"
Cohesion: 0.08
Nodes (32): TemplateApplicable, TemplateDefaults, TemplateDefinition, ViewLeaderErrorCode, checkTemplateDraft(), create(), FALLBACK_ROUTING, get() (+24 more)

### Community 5 - "Saved View Coordinator"
Cohesion: 0.13
Nodes (8): fingerprint(), isAbortError(), linkAbort(), SavedViewCoordinator, sortDefinitions(), LinearTourDefinition, SavedViewsRuntimeSnapshot, freezeSavedView()

### Community 6 - "Saved View Activation State"
Cohesion: 0.06
Nodes (37): AnnotationViewRuntimeState, abortError(), abortReason(), ActivationOperation, ActiveRollback, CaptureNeutralSavedViewInput, idleActivation, idlePlayback (+29 more)

### Community 7 - "ViewLeader Facade"
Cohesion: 0.10
Nodes (5): definitionsFromCollections(), DefinitionsPublicCapability, isElement(), runCleanupSteps(), ViewLeader

### Community 8 - "Handle Editing Port"
Cohesion: 0.08
Nodes (13): EditingCancellationReason, EditingDragKind, EMPTY, HandleEditingPort, HandleKind, HandlePointerProps, HandlesController, HandlesControllerOptions (+5 more)

### Community 9 - "Boundary Lifecycle"
Cohesion: 0.09
Nodes (22): BoundaryLifecycle, BoundaryOptions, CapabilitySubscription, DisposableViewLeader, SnapshotSource, ViewLeaderFactory, ReactViewLeaderBinding, useViewLeader() (+14 more)

### Community 10 - "Three.js Adapter Bundle"
Cohesion: 0.08
Nodes (33): ElementInvalidation, SurfacePickResult, applyCameraState(), assertCameraCompatible(), assertFiniteCameraNumbers(), cancelTrackedPointers(), captureCameraState(), copyVector() (+25 more)

### Community 11 - "React Binding Hooks"
Cohesion: 0.09
Nodes (29): subscribeFrame(), HandleEntry, TemplateCaptureOptions, OpenTextEditorOptions, TextEditorSnapshot, useEditingKeyboard(), useFollow(), useHandles() (+21 more)

### Community 12 - "TypeScript Build Config"
Cohesion: 0.05
Nodes (39): src/index.ts, src/markdown/index.ts, src/react/index.ts, src/three/index.ts, src/vue/index.ts, test, tsup.config.ts, vitest.config.ts (+31 more)

### Community 13 - "Demo Package Dependencies"
Cohesion: 0.05
Nodes (38): dependencies, @fontsource/inter, react, react-dom, three, viewleader, vue, web-ifc (+30 more)

### Community 14 - "Inline Text Editing"
Cohesion: 0.09
Nodes (27): BuiltInContentLayout, FollowOptions, FollowTarget, HandleFollowSink, DoubleClickEventLike, EditableTextField, FIELD_NAMES, installPointerGuard() (+19 more)

### Community 15 - "Tag Text Resolution"
Cohesion: 0.09
Nodes (16): TagTextAdapter, TagTextInvalidation, describe(), matches(), PendingTag, referenceKey(), TagTextHooks, TagTextResolutionManager (+8 more)

### Community 16 - "Runtime Frame Loop"
Cohesion: 0.09
Nodes (4): clearFrameSeam(), runCleanupSteps(), sameSet(), ViewLeaderRuntime

### Community 17 - "Markup Authoring Capability"
Cohesion: 0.15
Nodes (5): ActiveMarkupAuthoring, assertExistingIndex(), MarkupAuthoringCapability, requireLeg(), validateNormalizedPointer()

### Community 18 - "Demo Example Pages"
Cohesion: 0.27
Nodes (17): AXES, MenuItem, TextContent, LEGS, setup(), claimChromeEdges(), createControlBar(), createExampleHarness() (+9 more)

### Community 19 - "Resolved Style Types"
Cohesion: 0.09
Nodes (31): ContentLayoutOptions, DEFAULT_STYLE_ID, EnclosureDefinition, mergeStyleOverride(), readGroup(), readStyleOverride(), ResolvedStyle, resolveStyleWithProvenance() (+23 more)

### Community 20 - "Paper Millimetre Theme"
Cohesion: 0.09
Nodes (25): definitionFromJson(), ASCENT_RATIO, CAD_DARK, CAD_PAPER, CAP_RATIO, LINE_SPACING_RATIO, lineweight(), mm() (+17 more)

### Community 21 - "Style Editor"
Cohesion: 0.09
Nodes (25): StyleFieldSource, DEFAULT_LABELS, EMPTY_SNAPSHOT, MutableStyleOverride, sameValue(), SelectionValue, StyleEditor, StyleEditorLabels (+17 more)

### Community 22 - "BCF Interchange Codec"
Cohesion: 0.12
Nodes (30): annotationsForView(), cleanZero(), commentsXml(), decoder, encoder, exportAxis(), exportBcf(), first() (+22 more)

### Community 23 - "Follow Registry"
Cohesion: 0.09
Nodes (17): applyHidden(), applyResolved(), FollowGeometrySource, FollowMissingBehaviour, FollowRegistry, FollowRegistryOptions, followTargetKey(), LastWrite (+9 more)

### Community 24 - "Markdown Plugin"
Cohesion: 0.10
Nodes (33): assertMarkdownCharacterBound(), assertMarkdownRecordShape(), DEFAULT_MARKDOWN_PLUGIN_LIMITS, isJsonObject(), MARKDOWN_PLUGIN_ID, MARKDOWN_RECORD_TYPE, MARKDOWN_WRAP_WIDTH, MarkdownAst (+25 more)

### Community 25 - "Editing Controller"
Cohesion: 0.13
Nodes (8): applyMarqueeMode(), EditingController, hasStyle(), isHostChrome(), manualLength(), rectFromPoints(), rectsOverlap(), isPointerEvent()

### Community 26 - "Neutral Viewer State"
Cohesion: 0.09
Nodes (11): MutableSavedViewDocument, NeutralViewerState, SavedViewDocumentSnapshot, ViewerStateAdapter, PreparedThreeViewerState, CreateViewsCapabilityOptions, adapters, Prepared (+3 more)

### Community 27 - "Render Primitives Cache"
Cohesion: 0.09
Nodes (31): ContentBounds, LINE_HEIGHT, DeclarativePathCommand, ImageFrameState, annotationStructureSignature(), CachedAnnotationGroup, CachedInkGroup, CommandTransform (+23 more)

### Community 28 - "Saved View Validation"
Cohesion: 0.20
Nodes (31): assertExactKeys(), assertId(), assertName(), assertUnique(), boolean(), compareElement(), deepFreeze(), duration() (+23 more)

### Community 29 - "Graded Scene Harnesses"
Cohesion: 0.16
Nodes (20): adversarialExtras(), adversarialScene(), adversarial(), AdversarialSceneHandle, draftFor(), Box, ORBIT_STEPS, overlappingPairs() (+12 more)

### Community 30 - "Host Adapter Integration"
Cohesion: 0.12
Nodes (16): AccuratePickRequest, DiagnosticSeverity, elementKey(), ElementResolveRequest, HostImageAdapter, HostIntegration, isAbortError(), isFiniteVec3() (+8 more)

### Community 31 - "Content Markup Modules"
Cohesion: 0.10
Nodes (11): ContentMarkupModuleOptions, ContentMarkupModules, createContentMarkupModules(), DefinitionDocumentPort, ExtensionLimits, HostAdapterBundle, HostImagePort, ImageDiagnostic (+3 more)

### Community 32 - "Text Editor Controller"
Cohesion: 0.13
Nodes (8): directionOf(), get(), hitTestScreen(), localPoint(), TextEditorController, update(), LabelTextEditorProps, type()

### Community 33 - "Label Placement"
Cohesion: 0.14
Nodes (24): clampX(), clampY(), ConnectionEdge, EDGE_MARGIN, InternalAnchor, LabelPlacer, LabelSector, NO_INSETS (+16 more)

### Community 34 - "SVG Overlay Writer"
Cohesion: 0.20
Nodes (9): clearAnchorHead(), cloudPath(), drawnRoutePath(), format(), pointPath(), setOccludedStroke(), setStroke(), SvgOverlay (+1 more)

### Community 35 - "Editing API Tests"
Cohesion: 0.09
Nodes (17): AnnotationDraft, adapters, VIEWPORT, adapters, build(), note(), adapters, build() (+9 more)

### Community 36 - "Framework Conformance Tests"
Cohesion: 0.12
Nodes (17): cancel(), Capability, clearSelection(), createFakeInstance(), deselect(), emptyResources(), FakeInstance, FrameworkHarnessAdapters (+9 more)

### Community 37 - "Authoring Session Types"
Cohesion: 0.12
Nodes (15): ActiveSession, AuthoringCancellationReason, AuthoringDraft, AuthoringOutcome, AuthoringPreview, cancellationStatus(), isHtmlElement(), StartAuthoringOptions (+7 more)

### Community 38 - "Annotative Scale Tests"
Cohesion: 0.08
Nodes (9): StyleDefinition, adapters, style, adapters, fixedAdapters, adapters, build(), style() (+1 more)

### Community 39 - "Document Normalization"
Cohesion: 0.20
Nodes (26): arrayValue(), carriedResidue(), envelopeKey(), finiteNumber(), normalizeAnchor(), normalizeAnnotation(), normalizeContent(), normalizeDefinitions() (+18 more)

### Community 40 - "Occlusion Policy"
Cohesion: 0.12
Nodes (15): AdapterError, OcclusionAdapter, applyOcclusionPolicy(), batchSignature(), CompletedBatch, OcclusionBatchRequest, OcclusionManager, occlusionPortFromAdapter() (+7 more)

### Community 41 - "Demo Control Bar"
Cohesion: 0.08
Nodes (7): buildSelect(), ContinuousChange, ControlBar, ControlSelect, PanelField, PanelSection, SidePanel

### Community 42 - "Drafting Standards Lint"
Cohesion: 0.14
Nodes (19): classifyIntersection(), cross(), distance(), finitePoint(), firstSloped(), inclusiveIntersection(), Intersection, IntersectionKind (+11 more)

### Community 43 - "Demo Page Rationale"
Cohesion: 0.12
Nodes (24): Markup & multi-leaders example page, Example page shell convention (header + viewport + View source), Occlusion & hidden legs example page, #performance-boundary element (overlay boundary + status output), Browser performance harness page, Plugin anatomy example page, Duplex_A_20110907.ifc buildingSMART fixture (CC BY 4.0), Host owns IFC parsing; core and adapters never parse IFC (+16 more)

### Community 44 - "Content Layout Engine"
Cohesion: 0.24
Nodes (23): alignedLeft(), anchorX(), BoxOptions, boxTextLayout(), calloutLayout(), ContentPrimitive, enclosure(), fitBox() (+15 more)

### Community 45 - "Host Image Resolution"
Cohesion: 0.13
Nodes (13): DEFAULT_IMAGE_HEIGHT, DEFAULT_IMAGE_WIDTH, FailedImage, HostImageResolveRequest, HostResolvedImage, imageBounds(), ImageResolutionManager, ImageRuntimeHooks (+5 more)

### Community 46 - "Layout Frame Projection"
Cohesion: 0.09
Nodes (11): Bounds2, RenderPrimitive, textLineOffsets(), anchorCloudFrame(), applyOcclusionPresentation(), centroid(), deepFreeze(), freezeOverrides() (+3 more)

### Community 47 - "IFC Studio Demo"
Cohesion: 0.11
Nodes (16): AppearanceField, ChoiceField, ColorField, RangeField, ROUTING_MODES, syncPanel(), TextContent, ToolOutcome (+8 more)

### Community 48 - "Root Dev Dependencies"
Cohesion: 0.09
Nodes (23): jsdom, devDependencies, jsdom, @playwright/test, react-dom, tsup, @types/jsdom, @types/node (+15 more)

### Community 49 - "Dogleg Routing Tests"
Cohesion: 0.09
Nodes (14): DEFAULT_LANDING, above, adapters, below, dogleg(), label, render(), right (+6 more)

### Community 50 - "Document Engine Transactions"
Cohesion: 0.17
Nodes (6): assertId(), assertLabel(), DocumentEngine, isThenable(), normalizeAnnotationDraft(), EditingControllerOptions

### Community 51 - "Markup Annotation Drafts"
Cohesion: 0.11
Nodes (21): AnnotationLeg, assertInsertionIndex(), CommitRegionOptions, immutablePreview(), isPointerEvent(), ManagedMarkupAuthoringPreview, MarkupAnnotationDraft, MarkupAuthoringCancellationReason (+13 more)

### Community 52 - "Demo TypeScript Config"
Cohesion: 0.09
Nodes (21): compilerOptions, exactOptionalPropertyTypes, jsx, lib, module, moduleResolution, noEmit, noUncheckedIndexedAccess (+13 more)

### Community 53 - "Performance Gate Scripts"
Cohesion: 0.14
Nodes (16): requireContainer, resultArgument, formatPerformanceReport(), PERFORMANCE_PROFILE, PERFORMANCE_PROTOCOL, PERFORMANCE_SCENARIOS, runPerformanceHarness(), summarize() (+8 more)

### Community 54 - "Projection Adapter"
Cohesion: 0.10
Nodes (7): ElementResolution, ProjectionAdapter, ResolvedLeg, DrawingPlane, SurfacePlanePick, OcclusionCandidate, Vec3

### Community 55 - "Views Document Port"
Cohesion: 0.16
Nodes (11): SavedViewDocumentPort, assertUniqueDefinitionIds(), CanonicalViewsDocumentPort, compareDefinitions(), CreatedViewsCapability, decodeSavedView(), decodeTour(), encodeJsonObject() (+3 more)

### Community 57 - "Example Registry Wiring"
Cohesion: 0.12
Nodes (6): ExampleRoute, EXAMPLES, PAGES, Editor, examples, demo

### Community 58 - "Adversarial Scene Fixtures"
Cohesion: 0.15
Nodes (17): ADVERSARIAL_SCENE_COUNT, ADVERSARIAL_SCENE_SEED, BACK_WALL, mulberry32(), PHRASES, crowdedDrafts(), draftFor(), CROWDED_SCENE_COUNT (+9 more)

### Community 60 - "Obstacle Aware Routing"
Cohesion: 0.13
Nodes (13): LandingRender, LandingSide, average(), breakAroundObstacles(), finitePoint(), LandingGeometry, resetPlacement(), resetRoute() (+5 more)

### Community 61 - "Document Schema Migrations"
Cohesion: 0.14
Nodes (18): ANNOTATION_KEYS, applyAnnotationPatch(), createEmptyDocument(), deepFreeze(), DEFAULT_DOCUMENT_LIMITS, DOCUMENT_KEYS, DOCUMENT_MIGRATIONS, DocumentCommitKind (+10 more)

### Community 62 - "Views Capability Tours"
Cohesion: 0.21
Nodes (4): SavedViewDefinition, ViewActivationOutcome, createViewsCapability(), ViewsCapability

### Community 63 - "Error Class Hierarchy"
Cohesion: 0.15
Nodes (9): DisposedError, DocumentTooLargeError, DuplicateIdError, InvalidConfigurationError, InvalidDocumentError, InvalidInputError, InvariantViolationError, NotFoundError (+1 more)

### Community 64 - "Occluded Leg Tests"
Cohesion: 0.14
Nodes (12): OcclusionResult, OcclusionSample, ResolvedHostImage, adapters(), boundary(), dashes(), occludedScene(), opacities() (+4 more)

### Community 65 - "BCF Apply Planner"
Cohesion: 0.15
Nodes (17): BcfApplyPlan, BcfApplyPlanOptions, BcfResolvedComponentAnchor, planBcfApply(), PlannedBcfAnnotation, PlannedBcfView, PlannedEmbeddedBcfDocument, safeIdentity() (+9 more)

### Community 66 - "Zip Archive Plumbing"
Cohesion: 0.19
Nodes (18): CentralEntry, centralHeader(), concat(), crc32(), crcTable, decoder, encoder, findEnd() (+10 more)

### Community 67 - "Package Manifest Metadata"
Cohesion: 0.11
Nodes (17): bugs, url, description, engines, node, homepage, license, name (+9 more)

### Community 68 - "Drag Hit Tolerance"
Cohesion: 0.21
Nodes (15): ActiveDrag, ActiveMarquee, DRAG_THRESHOLD_PX, LEADER_HIT_TOLERANCE_PX, regionVertices(), resizeAbout(), InteractionLease, createRegionAnchor() (+7 more)

### Community 69 - "Interchange Document Ops"
Cohesion: 0.16
Nodes (11): ElementLikeAnchor, FallbackLookup, IdentifiedDocument, mergeIdentifiedDocuments(), RefreshableRecord, refreshAnchor(), refreshElementFallbacksOnSave(), TransactionalDocumentTarget (+3 more)

### Community 70 - "Editing Keyboard Nudge"
Cohesion: 0.16
Nodes (11): EditingKeyboard, EditingKeyboardOptions, isTextEntryTarget(), NUDGE, NudgeStep, adapters, build(), built (+3 more)

### Community 71 - "Label Separation Insets"
Cohesion: 0.16
Nodes (14): ViewportInsets, ascending(), centerX(), centerY(), clampCell(), clampToViewport(), getOverlap(), MAX_ITERATIONS (+6 more)

### Community 72 - "Route Vertex Editing"
Cohesion: 0.22
Nodes (18): addRouteVertex(), copyPoint(), dedupePoints(), doglegRoute(), finiteBounds(), manualVertices(), moveRouteVertex(), rectangleAttachment() (+10 more)

### Community 73 - "Package Entry Points"
Cohesion: 0.12
Nodes (17): exports, ./interchange, ./markdown, ./package.json, ./react, ./three, ./vue, import (+9 more)

### Community 74 - "Handles Tests"
Cohesion: 0.15
Nodes (8): HandlePointerEvent, EVERY_KIND, fakeController(), keyOf(), pannableAdapters(), recordingFollow(), Viewer, VIEWPORT

### Community 75 - "Text Metrics Font Loading"
Cohesion: 0.20
Nodes (13): LayoutFonts, wrapParagraph(), cache, canvasIsUnavailable(), estimateTextWidth(), FontSpec, invalidateTextMetrics(), isWideCodePoint() (+5 more)

### Community 76 - "Vector Sheet Export"
Cohesion: 0.25
Nodes (15): appendTitleBlock(), createSvg(), exportVectorSheet(), finitePositive(), numericAttribute(), prepareMarkdownImages(), prependComposition(), rasterizeVectorSheet() (+7 more)

### Community 77 - "Demo Performance Harness"
Cohesion: 0.19
Nodes (13): boundary, createDocument(), nextFrame(), PerformanceProtocol, PerformanceReport, PerformanceRun, PerformanceScenario, run() (+5 more)

### Community 78 - "Region Ink Editing Tests"
Cohesion: 0.17
Nodes (12): at(), drag(), dragRegionHandle(), FLAT, makeLeader(), OBLIQUE, projectionAt(), RECTANGLE (+4 more)

### Community 79 - "IFC Web Worker"
Cohesion: 0.25
Nodes (10): post(), run(), scope, WorkerScope, IfcChunk, IfcElementRecord, IfcGeometryRecord, IfcPlacement (+2 more)

### Community 80 - "Editing Hit Testing"
Cohesion: 0.25
Nodes (3): NormalizedPointerInput, ScreenHit, EditingCapability

### Community 81 - "Leader Break Detour"
Cohesion: 0.18
Nodes (12): pointInside(), segmentThroughInterior(), detourAround(), detourOnce(), obstacleHits(), crosses(), IN_THE_WAY, LEADER (+4 more)

### Community 82 - "Region Ink Geometry"
Cohesion: 0.18
Nodes (14): EllipseRegionGeometry, PolygonRegionGeometry, ProjectedInk, ProjectedRegion, RectangleRegionGeometry, RevisionCloudArc, RevisionCloudGeometry, AnnotationHandle (+6 more)

### Community 83 - "Region Attachment Tests"
Cohesion: 0.16
Nodes (11): RegionAttachmentZone, ScreenBounds, adapters, attach(), ellipse, labelAt(), mount(), note() (+3 more)

### Community 84 - "NPM Script Gate"
Cohesion: 0.15
Nodes (13): scripts, build, build:demo, check, dev:demo, perf:browser, perf:gate, prepublishOnly (+5 more)

### Community 85 - "Document Compatibility Tests"
Cohesion: 0.21
Nodes (8): CURRENT_DOCUMENT_VERSION, adapters(), boundary(), V1_DOCUMENT, withNote(), futureAnnotation(), futureDocument(), futureLeg()

### Community 87 - "Vector Math Helpers"
Cohesion: 0.26
Nodes (13): assertExactKeys(), copyVec3(), cross(), dot(), drawingPlaneFromSurfacePick(), localBounds(), magnitude(), normalize() (+5 more)

### Community 88 - "Late Font Remeasure Tests"
Cohesion: 0.17
Nodes (8): adapters, fakeContext, FakeFontFaceSet, installFonts(), landed, measured, note(), wrapping()

### Community 89 - "Package Keywords"
Cohesion: 0.17
Nodes (12): keywords, 3d, annotation, bcf, bim, callout, ifc, label-placement (+4 more)

### Community 90 - "Align And Distribute"
Cohesion: 0.26
Nodes (11): AlignEdge, alignedStart(), alignedValue(), alignMoves(), ArrangeMove, ArrangeTarget, distributeMoves(), horizontal() (+3 more)

### Community 91 - "Built-in Content Fonts"
Cohesion: 0.20
Nodes (8): DEFAULT_FONT_FAMILY, defaultAlign(), defaultWeight(), fonts(), layoutBuiltInContent(), FONT_STACK, textLines(), adapters

### Community 92 - "Document Serialization Limits"
Cohesion: 0.24
Nodes (8): assertByteLimit(), canonicalStringify(), isResolvedLimits(), parseDocument(), prepareDocument(), resolveLimits(), serializeDocument(), sortJson()

### Community 94 - "Three Adapter Tests"
Cohesion: 0.18
Nodes (5): createThreeElementInvalidationChannel(), ThreeHostViewerState, hostStateWithModelVisibility(), StubCanvas, viewerStateAt()

### Community 95 - "Content Primitive Types"
Cohesion: 0.20
Nodes (8): BasePrimitive, DEFAULT_FONT_SIZE, DEFAULT_PADDING, ImagePrimitive, PathPrimitive, TextPrimitive, boundary(), render()

### Community 96 - "Diagnostics Channel"
Cohesion: 0.20
Nodes (3): Diagnostic, isFiniteVec2(), PreparedReplacement

### Community 97 - "Frame Seam"
Cohesion: 0.22
Nodes (9): emitFrame(), emitterByOwner, FrameListener, linkFrameSeam(), listenersByEmitter, unlinkFrameSeam(), adapters(), build() (+1 more)

### Community 98 - "Forward Compatible Sections"
Cohesion: 0.36
Nodes (9): annotation(), futureDocument(), futureInk(), futureSavedView(), futureStyle(), futureTerminator(), futureTour(), PLANE (+1 more)

### Community 99 - "Build Gate Rationale"
Cohesion: 0.20
Nodes (10): Build before typecheck and test, npm run check full gate, HostAdapterBundle seam, Saved-views neutral-types hard boundary, Package boundary test (declaration-graph walk), Hello world example page, Model reload & recovery example page, createThreeAdapter (+2 more)

### Community 100 - "React Demo Page"
Cohesion: 0.20
Nodes (3): LabelEditor, MountedViewer(), ReadyBoundary

### Community 101 - "Optional Peer Dependencies"
Cohesion: 0.20
Nodes (10): react, three, vue, react, three, vue, peerDependencies, react (+2 more)

### Community 102 - "Markup Lifecycle Tests"
Cohesion: 0.20
Nodes (5): markdownPlugin, ClosedRegionGeometry, geometries, plane, pointer

### Community 103 - "Annotative Scale Fixture"
Cohesion: 0.29
Nodes (7): adapters, boundary(), Fixture, group(), labelScale(), measured(), numbers()

### Community 104 - "Arrange Tests"
Cohesion: 0.24
Nodes (8): fixedAdapters, makeLeader(), note(), SIX, SIX_Y, sixNotes(), VIEWPORT, withNotes()

### Community 106 - "Multi Point Authoring Tests"
Cohesion: 0.24
Nodes (6): adapters(), beam, boundary(), session(), VIEWPORT, worldPoint

### Community 107 - "Theme Option Tests"
Cohesion: 0.29
Nodes (7): adapters, boundary(), draft(), gallery(), Instance, render(), STYLE_IDS

### Community 108 - "Host Chrome Rationale"
Cohesion: 0.25
Nodes (9): host-menu context/grip menu chrome, host-text-field inline editor chrome, Host chrome example page, Model tree with native <details> disclosure, IFC studio example page, Separate name and eye buttons per tree row, vl-authoring-preview layer (host draws the live leader), Leader editor example page (+1 more)

### Community 109 - "Definition Reference Counts"
Cohesion: 0.31
Nodes (5): DefinitionKind, DefinitionMutation, DefinitionReferenceCounts, TypedDefinition, DefinitionPortFake

### Community 111 - "Document Residue Expansion"
Cohesion: 0.36
Nodes (9): alignedArray(), annotationKey(), applyResidue(), expandAnnotation(), expandDocument(), isPlainObject(), RawDocument, residueOf() (+1 more)

### Community 112 - "Documents Capability"
Cohesion: 0.25
Nodes (5): DocumentCommit, DocumentEditResult, HistoryEntry, ViewLeaderDocument, DocumentsCapability

### Community 113 - "Boundary Frame Memory"
Cohesion: 0.36
Nodes (6): BoundaryMemory, corners(), projectWorldAabb(), rectToBounds(), resolveLayoutFrame(), resolveOrganizationRect()

### Community 115 - "Editing Cursor Tests"
Cohesion: 0.25
Nodes (5): EMPTY, fixedAdapters, note(), VIEWPORT, worldFor()

### Community 116 - "Marquee Selection Tests"
Cohesion: 0.28
Nodes (6): at(), fixedAdapters, marquee(), note(), VIEWPORT, worldFor()

### Community 117 - "Route Grip Tests"
Cohesion: 0.25
Nodes (4): at(), dragRouteHandle(), fixedAdapters, VIEWPORT

### Community 118 - "Snap Hook Tests"
Cohesion: 0.28
Nodes (6): adapters(), boundary(), FRAME, makeLeader(), ORIGIN, VIEWPORT

### Community 119 - "Region Visibility Tests"
Cohesion: 0.31
Nodes (7): adapters(), boundary(), CORNERS, PLANE, regionDraft(), rendered(), VIEWPORT

### Community 120 - "Style Override Tests"
Cohesion: 0.25
Nodes (4): adapters, boundary(), captured, render()

### Community 121 - "README Integration Rationale"
Cohesion: 0.29
Nodes (8): Instance identity keyed on the boundary element, Direct editing example page, Armed-tool aria-pressed control bar, Picking the right boundary element, dispose() on unmount, editing.gestures opt-in and marquee modifier default, forwardWheelTo canvas, Interaction lease over OrbitControls

### Community 122 - "README Export Rationale"
Cohesion: 0.25
Nodes (8): Plugin runtime (coreApiRange, migrations, render hook), BCF 2.1 round trip example page, Six entry points, exportVectorSheet, rasterizeVectorSheet, Sheet's two coordinate spaces and preserveAspectRatio, underlayDataUrl must be a data: URI, Value vs type imports (verbatimModuleSyntax)

### Community 123 - "Ink Annotation CRUD"
Cohesion: 0.43
Nodes (3): InkAnnotation, inkFromJson(), inkToJson()

### Community 124 - "Terminator Path Rendering"
Cohesion: 0.32
Nodes (6): applyAccessibility(), commandPath(), fitEnclosurePath(), mapCommand(), resolveTerminator(), sortedPrimitives()

### Community 125 - "Editing Drag Tests"
Cohesion: 0.29
Nodes (4): at(), drag(), fixedAdapters, VIEWPORT

### Community 126 - "Placement Mode Inset Tests"
Cohesion: 0.32
Nodes (6): adapters(), boundary(), TALL_FRAME, VIEWPORT, WIDE_FRAME, withNotes()

### Community 127 - "Drafting Convention Rationale"
Cohesion: 0.33
Nodes (7): data-vl-ready readiness signal, Drafting-standards lint (ASME Y14.2 / ISO 128-22 / ISO 3098), The demo gallery has one list (EXAMPLES registry), Paper millimetres and CAD pen weights as units, Drafting styles example page, Example gallery index page, View-source .ts.txt link convention

### Community 128 - "Optional Peer Metadata"
Cohesion: 0.29
Nodes (7): peerDependenciesMeta, react, three, vue, optional, optional, optional

### Community 129 - "History Coalescing Tests"
Cohesion: 0.38
Nodes (5): adapters, build(), note(), nudge(), positionOf()

### Community 130 - "Performance Protocol Types"
Cohesion: 0.33
Nodes (4): PerformanceProtocol, PerformanceReport, PerformanceRun, PerformanceScenario

### Community 131 - "Frame Persistence Tests"
Cohesion: 0.47
Nodes (5): adapters(), boundary(), FRAME, VIEWPORT, withNotes()

### Community 132 - "Pages Deploy Workflow"
Cohesion: 0.40
Nodes (5): DEMO_BASE path prefix, Deploy demo to Pages workflow, No cross-origin isolation headers (single-threaded web-ifc), Queued pages concurrency group, %BASE_URL% link placeholder

### Community 133 - "Core Architecture Invariants"
Cohesion: 0.40
Nodes (5): Facade → runtime → engines layering, The frame pipeline (runtime.update), Live previews beat stored state, No-swimming invariant, Test fixtures are oracles

### Community 134 - "Leader Editor Demo"
Cohesion: 0.40
Nodes (3): ROUTING_MODES, TextContent, ToolOutcome

### Community 135 - "Published Package Files"
Cohesion: 0.40
Nodes (5): files, CHANGELOG.md, dist, LICENSE, README.md

### Community 137 - "Release Publish Workflow"
Cohesion: 0.50
Nodes (4): Prerelease dist-tag routing (beta vs latest), Release workflow (tag-triggered npm publish), Tag matches package.json version gate, npm trusted publishing via OIDC

### Community 140 - "Overlay Hit Test Plan"
Cohesion: 0.50
Nodes (3): hitTestInkPlan(), hitTestPlan(), onOutline()

### Community 142 - "Plan Snapshot Test"
Cohesion: 0.67
Nodes (3): planText(), px(), SCENE_A_SNAPSHOT

## Ambiguous Edges - Review These
- `Occlusion & hidden legs example page` → `Label rail columns at x=44.89 and x=648.60 (labels railed outside the frame)`  [AMBIGUOUS]
  test/snapshots/scene-a-plan.txt · relation: conceptually_related_to
- `web-ifc 0.0.74 pinned WASM artifact` → `Workbench example page`  [AMBIGUOUS]
  demo/workbench/index.html · relation: references

## Knowledge Gaps
- **454 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+449 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **18 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Occlusion & hidden legs example page` and `Label rail columns at x=44.89 and x=648.60 (labels railed outside the frame)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `web-ifc 0.0.74 pinned WASM artifact` and `Workbench example page`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **Why does `three` connect `IFC Studio Demo` to `Leader Editor Demo`, `Three.js Adapter Bundle`, `Demo Example Pages`, `Package Keywords`, `Three Adapter Tests`?**
  _High betweenness centrality (0.108) - this node is a cross-community bridge._
- **Why does `ViewLeader` connect `ViewLeader Facade` to `Plugin Extension Runtime`, `History Coalescing Tests`, `Public Snapshot Types`, `Frame Persistence Tests`, `Template Draft Capture`, `Boundary Lifecycle`, `React Binding Hooks`, `Inline Text Editing`, `Tag Text Resolution`, `Runtime Frame Loop`, `Markup Authoring Capability`, `Crowded Scene Handle`, `Paper Millimetre Theme`, `Style Editor`, `Editing Controller`, `Neutral Viewer State`, `Graded Scene Harnesses`, `Content Markup Modules`, `Editing API Tests`, `Annotative Scale Tests`, `Drafting Standards Lint`, `Dogleg Routing Tests`, `Document Engine Transactions`, `Projection Adapter`, `Views Document Port`, `Authoring Controller`, `Views Capability Tours`, `Occluded Leg Tests`, `Interchange Document Ops`, `Editing Keyboard Nudge`, `Handles Tests`, `Region Ink Editing Tests`, `Region Attachment Tests`, `Document Compatibility Tests`, `Late Font Remeasure Tests`, `Built-in Content Fonts`, `Three Adapter Tests`, `Content Primitive Types`, `Frame Seam`, `Forward Compatible Sections`, `Markup Lifecycle Tests`, `Annotative Scale Fixture`, `Arrange Tests`, `Editing Handle Tests`, `Multi Point Authoring Tests`, `Theme Option Tests`, `Layout Frame Tests`, `Editing Cursor Tests`, `Marquee Selection Tests`, `Route Grip Tests`, `Snap Hook Tests`, `Region Visibility Tests`, `Style Override Tests`, `Editing Drag Tests`, `Placement Mode Inset Tests`?**
  _High betweenness centrality (0.086) - this node is a cross-community bridge._
- **Why does `keywords` connect `Package Keywords` to `Package Manifest Metadata`, `IFC Studio Demo`?**
  _High betweenness centrality (0.066) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _454 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Plugin Extension Runtime` be split into smaller, more focused modules?**
  _Cohesion score 0.06073871409028728 - nodes in this community are weakly interconnected._