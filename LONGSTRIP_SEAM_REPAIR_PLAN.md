# Longstrip Seam-Safe OCR and Typesetting

## Implementation plan for `komiq-cc/manga-typesetter`

**Status:** Implementation in progress; rendering and strip-bound changes are being verified.  
**Prepared:** September 21, 2026  
**Repository:** <https://github.com/komiq-cc/manga-typesetter>  
**Verified starting commit:** `47109459ec9d3ff1fec72004bc3bcb93159c7a3b`. The source paths and initial rendering diagnosis were checked against this commit during Milestone 0.

---

## 1. Objective and success criteria

Make longstrip chapters behave as continuous documents even when their artwork is stored in multiple source images.

A source-image boundary must not cause an otherwise continuous text region to become two independent OCR/translation entries. It must not hide lettering, constrain a text box to the wrong dimensions, or change the appearance of an export.

The central rule is:

> Keep artwork tiled for memory efficiency. Treat text geometry and rendering as continuous across the strip. Treat export cuts as a separate packaging decision.

### Required outcomes

- A typeset object crossing an image boundary remains visible, selectable, movable, and editable above both images.
- OCR can reconstruct a text region spanning a source seam using neighboring pixels and explicit coordinate transforms.
- An accepted repaired region has one logical identity, one queue entry, and one default typeset object rather than duplicate fragment objects.
- Repair preserves authored translations, styles, and manual placements, or presents an explicit conflict instead of overwriting them.
- Reassembling lossless longstrip export slices reproduces the corresponding continuous rendering.
- Save/reopen and undo/redo preserve region identity, cross-seam geometry, and repair decisions.
- Ordinary paged-mode behavior remains unchanged.

A balloon can legitimately contain multiple independently styled text regions. Do not turn “one repaired region” into a blanket rule that every balloon must contain exactly one text box.

## 2. Scope, assumptions, and non-goals

### In scope

Longstrip editor layering, strip coordinates, cross-seam interaction and fitting, seam-aware OCR, non-destructive reconciliation, persistence, history, output cut protection, and regression coverage.

### Assumptions to validate

The input images are ordered correctly and represent contiguous portions of the same chapter. Reconstruction is possible only where the relevant source pixels still exist. OCR cannot recover missing pixels introduced by destructive cropping.

Raw and cleaned artwork may differ in resolution. Pure resizing can use an explicit scale transform. Cropping, padding, or other registration changes require a known mapping; do not assume that a width/height ratio alone establishes alignment.

Not every neighboring file necessarily forms a continuous balloon. Separate chapters, intentional page breaks, or incompatible image alignment must not be treated as proof of continuity.

### Non-goals

Do not build a permanent giant bitmap of the whole chapter, replace the OCR model as a prerequisite, redesign the entire editor, or require an immediate migration of all box coordinates to a new global-only storage model. Do not solve the problem by merely moving export cuts, concatenating OCR strings, raising an arbitrary `z-index`, or clipping text back into its owner image.

## 3. Starting diagnosis to verify

The preceding review identified four interacting problems. Milestone 0 must establish which remain present in the current checkout.

| Area | Starting point from the prior review | Consequence |
| --- | --- | --- |
| Analysis | `detectOnePage()` in `src/lib/sidecar.js` analyzes `p.raw` independently. | A seam-crossing region can reach detection and OCR as incomplete fragments. |
| Editor | Longstrip markup in `src/lib/editor/Canvas.svelte` gives individual page frames their own text layers. | Overflow is vulnerable to neighboring image paint order and page-local interaction rules. |
| Export | `renderStripSliceCanvas()` in `exporter.js` interleaves each page background with its text. | A later image can paint over text extending from an earlier page. |
| Bounds and state | Dragging, auto-height, detection replacement, and cut protection use page-centric assumptions. | Cross-seam objects can be constrained, replaced destructively, or ignored by output planning. |

Do not assume every symptom has the same cause. Rendering order and incomplete OCR require separate fixes.

### Checkout findings (September 21, 2026)

- `detectOnePage()` still analyzes each raw image independently. The existing Rust `detect_analyze` command accepts encoded image bytes, so a stitched window can use that entry point without a new command.
- Typeset boxes already have durable `box.id` values. OCR queue lines and `detect.boxes` currently associate by page-local `n`; repaired logical regions still need stable identity or an equivalent persisted association. A migration of every existing box ID is unnecessary.
- The known raw-to-display mapping is width and height scaling. There is no saved crop, padding, or registration transform for cleaned artwork. Seam analysis must reject unsupported alignment rather than infer one from dimensions alone.
- Whole-chapter longstrip PNG/JPG/WebP export uses the strip slicer. Current-page raster export and layered PSD export use page-oriented paths at the starting commit; both need explicit review under the composition rule.
- The original owner-page drag and auto-height bounds, per-frame editor text layers, and interleaved export painting were confirmed against the starting commit. Worktree changes made during this implementation are not part of that baseline.

## 4. Architectural invariants

1. **Artwork precedes lettering.** Every contributing background is painted below every contributing typeset object in longstrip mode.
2. **Ownership is not clipping.** A text object may remain associated with a source page while its bounds extend beyond that page.
3. **Document geometry is unzoomed.** Zoom, device-pixel ratio, and scroll position affect presentation, not saved coordinates.
4. **Identity is independent of position.** Region IDs do not derive from queue order, line number, OCR text, or the current owner page.
5. **Source seams are not export cuts.** Changing output slice sizes does not alter OCR, translations, ownership, or text layout.
6. **Repair is transactional.** Changes across all affected pages form one undoable operation and never silently discard authored content.
7. **Large images remain tiled.** Temporary analysis windows, decoding, and caches have explicit resource bounds.
8. **Uncertainty is visible.** Ambiguous continuity, incomplete detection, and conflicting translations become review items, not confident automatic merges.

## 5. Coordinate and data contracts

### 5.1 Canonical strip layout

Reuse the current strip layout calculations where possible, including `stripOffsets(pages, 1)` after verifying its behavior. Extend the layout contract to include both horizontal and vertical transforms.

Each page needs a stable ID, strip placement, rendered document dimensions, and mappings from raw/cleaned image coordinates into document coordinates. For centered images with unchanged intrinsic scale:

```text
stripX = ownerPageLeft + localX
stripY = ownerPageTop  + localY

screen coordinates = viewportTransform(strip coordinates)
```

Where layout resizes images, incorporate that scale in the page transform rather than silently assuming a one-to-one mapping. Use the same layout snapshot for artwork, overlays, hit testing, fitting, OCR projection, and export.

Mixed-width inputs must follow the existing explicit alignment policy. Do not silently stretch narrow pages or assume their content aligns with adjacent pages.

### 5.2 Preserve page-local box storage initially

Keep current owner-page box coordinates as the initial canonical storage representation. Derive strip-space bounds when needed; do not save an independently mutable duplicate of the same geometry.

A box owned by a 2,000-pixel-tall page may start at `y = 1880` and have height `300`. Its bottom at `2180` is valid in longstrip mode. Similarly, upward overflow may require a negative owner-local `y`.

Ownership stays stable during dragging. Reordering pages changes the derived strip placement of page-owned content; pending seam results based on the old layout must be invalidated.

### 5.3 Stable logical region identity

Introduce a stable region identifier and an explicit association between a queue entry, its OCR region, and its typeset object. Field names are proposed, not an instruction to duplicate existing equivalents.

Suggested logical metadata:

```text
regionId                  stable, persisted identity
ownerPageId               association, not a clip boundary
sourceFragments           source page IDs and image-space provenance
supersededRegionIds       original fragment identities after a merge
reviewState               accepted / pending / conflicting / incomplete
analysisRevision          source and layout revision used for the proposal
```

OCR-region geometry and typeset-box geometry are different things and may both be stored. Two independent copies of the same typeset geometry must not be stored and mutated separately.

When one region is refined, retain its ID where the correspondence is clear. For a many-to-one merge, create a new identity and preserve an explicit mapping from the old identities. Many-to-many or one-to-many changes require review unless there is a separately validated safe rule.

Assign missing IDs once during a versioned migration and persist them. Never regenerate identities on every load.

### 5.4 Temporary window transform

A seam analysis request must carry its document-space rectangle, source/layout revisions, and the exact transform used to prepare the model input.

For a uniform resize without model padding:

```text
stripX = windowLeft + detectedX / analysisScale
stripY = windowTop  + detectedY / analysisScale
```

If preprocessing uses letterboxing, cropping, or another transform, invert that actual transform instead. Do not apply the simplified formula to a padded model input.

Do not pass a stitched seam result into a page-oriented `applyDetection(result, pageA)` path unchanged. First map it into strip coordinates, reconcile it, and convert accepted geometry into the selected owner's coordinate system.

## 6. Target rendering and pixel access

### 6.1 Longstrip editor

Use one logical strip surface with separate layers:

```text
Strip surface
├── Artwork layer: independent, virtualized source images
├── Shared text overlay: all visible logical typeset objects
└── Interaction overlay: selection outlines and editing handles
```

Review ancestor transforms, stacking contexts, containment, and overflow rules before moving elements. Set layer order deliberately; avoid escalating unrelated `z-index` values.

The shared overlay must not block empty-surface interactions. Resolve background clicks to a page using strip coordinates, and resolve text clicks to a stable object ID. Preserve keyboard focus, multi-selection, drag/resize behavior, and existing editing shortcuts.

Mount text based on its visible painted bounds, including rotation and effects, rather than only the owner's page index. Keep active editing and drag targets mounted until the interaction ends.

### 6.2 Export compositor

Refactor longstrip rendering into two passes using one immutable layout snapshot:

```text
Pass 1: paint all artwork intersecting the requested output rectangle.
Pass 2: paint all lettering whose painted bounds intersect that rectangle,
        in stable document layer order.
```

Text contributors must be selected independently of background contributors. An owner image may be outside a slice while part of its lettering intersects that slice.

Retain existing text layout and painting machinery where compatible. Lay out a text object in its normal document geometry; do not refit or re-center it separately for each output slice.

Use document-space transforms for gradients, patterns, clipping, and effects. Provide any bleed/halo required by shadows or filters before cropping the final slice. Preserve the intended relationship between blend modes and the underlying artwork.

Route every longstrip export variant through the same composition rules, including exports cut at original source boundaries. Keep explicitly paged exports governed by paged-mode rules.

### 6.3 Shared strip-region reader

Add a bounded facility that reads a requested rectangle of the strip into a temporary raster. It should:

- Decode only intersecting source images, compose them according to the layout snapshot, and return the image plus its transform and revisions.
- Support rectangles spanning more than two files and distinguish raw OCR input from cleaned/display artwork.
- Apply pixel, dimension, cache, and concurrency limits; support cancellation and deterministic cleanup.

Use this facility for seam detection, complete-region OCR, and cross-seam balloon fitting. Unsupported raw/clean registration must produce a clear review/error state rather than misleading coordinates.

## 7. Milestone 0 — Establish the baseline and failing tests

**Deliverable:** A pinned baseline, reproducible fixtures, and verified current-code entry points.

- [x] Record the repository commit and locate the current rendering, OCR, fitting, queue, serializer, and history implementations.
- [x] Verify the starting diagnosis and identify all longstrip export routes.
- [x] Inspect the current test framework, coordinate conventions, box ownership rules, and raw/clean image transforms.
- [ ] Create small synthetic fixtures: a region crossing two images; two distinct regions beside a seam; a tall region crossing three short slices; and mixed-width inputs.
- [ ] Add failing tests for export overpainting, cross-seam editor interaction, fragmented OCR results, and preservation of edited translations.
- [ ] Record baseline memory and decoded-image behavior on a representative longstrip without inventing performance targets.

**Exit gate:** The current defects are reproducible, paths are confirmed, and no new implementation is justified solely by assumptions from the earlier review.

## 8. Milestone 1 — Stop lettering from disappearing

**Deliverable:** Correct editor and export composition, without requiring OCR changes.

### Work

- [x] Separate longstrip export artwork and text painting into two passes.
- [x] Select text contributors by painted strip bounds, not only the location of their owner image.
- [x] Introduce the shared longstrip text overlay and explicit artwork/text/control layer order.
- [x] Adapt hit testing and page selection so text no longer depends on DOM ancestry under its owner frame.
- [x] Retain stable object ordering for overlapping text objects.
- [ ] Verify stroke, rotation, shadow, gradient, and pattern behavior across seams.

**Worktree progress:** Whole-chapter and current-source-slice raster exports use the two-pass compositor. The editor uses a shared text overlay and mounts boxes by derived strip bounds. Dragging, nudging, and auto-height use chapter bounds when all page dimensions are measured. Contributor bounds include rotation and conservative effect reach, but curved/warped paint bounds and lossless slice equivalence still need verification. Longstrip PSD remains page-oriented and requires a separate layered-output design. These checks do not close the Milestone 1 exit gate yet.

### Tests before implementation

A manually positioned object extending down from A into B must remain above both backgrounds. Repeat for upward overflow from B into A and for an output slice that excludes the owner's image but includes its text. Assert selection and editing on both sides of the seam.

**Exit gate:** The disappearance defect is fixed in preview and all longstrip export routes. OCR may still produce fragments at this stage, but existing cross-seam text is not obscured.

**Independent release:** The compositor fix can ship before OCR repair. Do not present it as a complete solution to fragmented recognition.

## 9. Milestone 2 — Make geometry, fitting, and identity seam-safe

**Deliverable:** Continuous longstrip interactions and the data foundation required for safe repair.

### Work

- [ ] Centralize page-to-strip, strip-to-page, and viewport transforms.
- [ ] Make drag, resize, auto-height, and fitting constraints layout-aware. Keep paged-mode rules unchanged.
- [ ] Use actual document bounds and intended balloon geometry in longstrip mode instead of the owner image's bottom edge.
- [ ] Implement the bounded strip-region reader and use cross-seam pixels for balloon fitting.
- [x] Virtualize text by painted bounds and pin active editing objects.
- [ ] Introduce stable region IDs and explicit queue/object references, reusing existing stable identities where appropriate.
- [ ] Implement the schema migration and serializer support before new metadata can be written.
- [ ] Establish a multi-page transaction/history API for the future repair operation.

### Tests before implementation

Test coordinate round trips at different zoom levels, device-pixel ratios, mixed widths, and raw/clean resolutions. Test negative owner-local positions, overflow at the bottom, and constraints at the true top/bottom of the document.

Scroll the owner image out of view while its text remains visible on the adjacent image. Confirm that the object remains mounted and interactive. Verify balloon fitting against the complete reconstructed balloon rather than an incomplete owner-page crop.

Load an older project, assign IDs once, save it, and reopen it without identity changes.

**Exit gate:** Geometry survives view changes and persistence, editing remains stable across seams, and the application can represent a repaired region without depending on line numbers.

## 10. Milestone 3 — Add seam-aware OCR and safe reconciliation

**Deliverable:** A boundary-analysis pass that proposes and applies complete text regions without losing user work.

### 10.1 Analysis pipeline

- [ ] Keep normal page analysis as the fast baseline.
- [ ] Analyze every eligible source seam, even when the page pass detected no nearby fragments.
- [ ] Start with a configurable amount of context above and below the seam. A few hundred pixels is an experiment starting point, not a correctness guarantee.
- [ ] Expand a window when a candidate touches its top/bottom boundary or otherwise appears incomplete. Include additional source files when required.
- [ ] Bound maximum window pixels, model dimensions, expansion attempts, decoded-image cache, and concurrent jobs using measured limits.
- [ ] Detect regions in the combined window, then OCR only accepted new/repaired regions where possible.
- [ ] Map detections through the explicit model-window-strip transforms.
- [ ] Mark unresolved truncation or uncertain results for review at the resource limit.

Scanning every seam does not guarantee every detector failure is recoverable. Provide a manual “reanalyze this region across the seam” action using the same bounded reader.

### 10.2 Reconciliation rules

Match a complete candidate to existing fragments using geometry, source provenance, seam-crossing evidence, and balloon/region evidence where available. Text similarity may support a match but is not sufficient by itself.

Do not use ordinary intersection-over-union as the sole merge criterion. Fragment halves can have little overlap with each other; a complete candidate must establish their relationship. Likewise, proximity to a seam does not justify merging two separate bubbles.

Re-read the complete region instead of concatenating partial OCR strings. Deduplicate overlapping window results in strip space using stable matching rules and provenance.

### 10.3 Dedicated repair operation

Create a proposed `applySeamRepair()` path or an equivalent transactional operation. Do not reuse destructive page-wide detection replacement blindly.

Each proposal must include old-to-new region mappings, replacement OCR/geometry, confidence or review reasons, and the source/layout revision used to calculate it.

- [ ] Preserve unrelated queue entries and free text boxes exactly.
- [ ] Preserve authored translations, tags, styles, and manual geometry by explicit identity mappings.
- [ ] Automatically apply only changes proven safe under the chosen policy; default to preview when authored content is affected.
- [ ] Retain both authored translations when two fragments conflict. Never silently concatenate, discard, or choose one.
- [ ] Preserve deliberate separate typeset objects until the user accepts their replacement.
- [ ] Apply all accepted changes in one undoable transaction.
- [ ] Make retrying the same repair idempotent: no extra queue entries, identities, or duplicate boxes.
- [ ] Reject stale results after source replacement, page reordering, or conflicting edits; offer regeneration instead of overwriting current state.

### 10.4 Review experience

Show the seam window, the original fragments, the proposed complete region, and any translated or styled content that would change. Provide accept, reject, and retry-with-expanded-region actions. A rejected proposal must not immediately reappear as an automatic merge on every scan.

**Exit gate:** A supported cross-seam fixture becomes one logical entry and default object. Two neighboring independent regions remain separate. Authored content, cancellation, retries, stale results, and undo/redo all behave safely.

**Dependency:** Do not expose automatic repair until Milestone 2's identity, serialization, and transaction support is complete.

## 11. Milestone 4 — Harden output cuts, persistence, and release

**Deliverable:** End-to-end seam-safe behavior with safe project compatibility and bounded resource use.

### Cut planning

Extend the existing `forbiddenBands()` / `strip-cuts.js` approach rather than replacing it without evidence.

Protect accepted logical text-region bounds, reliably available complete balloon bounds, and actual typeset paint bounds including relevant effects. Use strip coordinates. Do not reduce this to a fixed padding around only placed boxes.

Treat these as cut preferences unless the product specifies a hard prohibition. When a hard output-size limit makes every valid cut intersect protected content, preserve the existing warning/review path. Never silently exceed a strict encoder or user limit.

Even an unavoidable cut must preserve both portions of a single consistently rendered object. Reassembled output must not lose, repeat, or independently refit lettering.

### Persistence and recovery

- [ ] Test save/reopen for repaired regions, alias mappings, review decisions, and overflowing boxes.
- [ ] Ensure old projects load without dropping boxes or translations.
- [ ] Preserve the original project or create a backup before an irreversible schema upgrade.
- [ ] Document older-version compatibility; do not claim downgraded applications can read new fields safely without testing.
- [ ] Confirm undo/redo restores the exact affected region IDs, translations, styles, geometry, and queue ordering.
- [ ] Keep temporary window images and transient proposals out of project files unless intentionally persisted.

### Release checks

- [ ] Re-run paged-mode, single-image, and standard OCR workflows.
- [ ] Test relevant browser/Tauri platform paths supported by the project, particularly scrolling, canvas behavior, and effects.
- [ ] Profile a representative longstrip and verify that peak memory follows configured windows/caches rather than total chapter height.
- [ ] Check cancellation and decoder cleanup during chapter switching and application teardown.
- [ ] Document user-visible changes and the distinction between source seams and export cuts.

**Exit gate:** The full acceptance matrix passes, existing work survives upgrades and repair, and resource limits fail visibly instead of producing silent truncation.

## 12. Proposed implementation map

Verify full paths and naming during Milestone 0. New modules below are suggestions; use existing architecture instead of creating parallel abstractions that already exist.

| Existing location / symbol | Intended responsibility |
| --- | --- |
| `src/lib/editor/Canvas.svelte` | Shared overlay, strip-based hit testing, visible-object selection. |
| Existing `styles.css` | Explicit layer order, overflow, containment, and pointer-event behavior. |
| `src/lib/editor/strip.js` | Authoritative layout snapshot and coordinate helpers. |
| `src/lib/TextBox.svelte` | Layout-aware drag/resize bounds and stable editing identity. |
| `growToFit()` implementation | Distinguish document constraints from owner-page constraints. |
| `src/lib/sidecar.js` | Coordinate page analysis, seam jobs, cancellation, and model-window metadata. |
| Existing Rust analysis entry points | Analyze provided window pixels and expose required coordinate/preprocessing metadata. Do not add a new endpoint if the current image endpoint already suffices. |
| `src/lib/store.svelte.js` | Stable region references and non-destructive repair transactions. |
| Existing `exporter.js` | Two-pass strip composition and slice-independent text layout. |
| `src/lib/editor/strip-cuts.js` | Protected intervals based on complete regions and painted bounds. |
| Existing serializers/history/tests | Versioned migration, identity preservation, transactions, and regression fixtures. |

Suggested pure/helper boundaries:

```text
strip-geometry           transforms, layout snapshots, painted-bound projection
strip-region-reader      bounded pixel composition and provenance
seam-analysis            adaptive window scheduling and result projection
seam-reconciliation      pure proposal generation and conflict classification
seam-repair transaction  atomic state changes and undo/redo
```

Keep state mutation out of detector-result projection and matching logic. Pure functions make seam tests deterministic and reduce the amount of UI/runtime setup needed.

## 13. Test matrix

Use synthetic or permission-cleared fixtures. Prefer deterministic fake detector results for geometry, identity, and merge-policy tests. Keep actual model inference tests separate so model variation does not make core state tests flaky.

| Test | Required result |
| --- | --- |
| Downward overflow A → B | Text stays above both images in editor and export. |
| Upward overflow B → A | Negative local coordinates render and remain editable correctly. |
| Owner outside export slice | Its intersecting lettering is still included. |
| Single bubble/text region cut in two | Accepted repair creates one logical region and default object. |
| Two distinct bubbles near a seam | No accidental merge. |
| Region spanning three short files | Adaptive reader includes all necessary source pixels. |
| Candidate still truncated at resource limit | Visible incomplete/review state; no confident silent merge. |
| Page pass misses both fragments | Seam pass still runs. |
| Raw/clean resizing and model letterboxing | Correct transforms without stretching the result into the owner page. |
| Unsupported registration or mixed-width ambiguity | Explicit review/error; no fabricated continuity. |
| Zoom, scroll, DPR, and page virtualization | Saved geometry remains unchanged and visible overflow stays mounted. |
| Edited translations on both fragments | Neither is lost; conflict is reviewable. |
| Manual/free text and unrelated regions | No unintended changes. |
| Repeated repair | Idempotent state and no duplicate objects. |
| Cancel, source replacement, reorder, or edit during analysis | No stale or partial application. |
| Accept → undo → redo → save → reopen | Stable identities and exact authored-content preservation. |
| Rotated text, stroke, shadow, gradient, pattern | Painted bounds and slice appearance remain consistent. |
| Hard output limit with no safe cut | Warning/explicit decision, with correctly rendered slices. |
| Old project and ordinary paged mode | Compatibility and existing page-local behavior remain intact. |

### Export equivalence test

For a small fixture, render one complete continuous reference using the same compositor and settings. Export it again using several cut patterns, including a cut through lettering, and reassemble the slices losslessly.

Assert identical dimensions and no missing/duplicated rows. Require pixel equality where deterministic rendering permits it; otherwise define a narrowly justified backend-specific tolerance and inspect differences around seams. Never hide missing text behind a broad visual-difference threshold. Include effects needing bleed pixels in this test.

Do not use JPEG for this equivalence assertion, because independent compression introduces unrelated differences.

## 14. Resource, concurrency, and failure policy

Analyze narrow windows instead of the entire chapter. Reuse decoded images and model sessions where supported, but bound retained resources. Measure before setting default window size, concurrency, cache size, or expansion limits.

Cache by source identity/revision, layout revision, requested rectangle, analysis settings, and model version as applicable. Geometry or source changes must invalidate results that depend on them.

Support cancellation between seams and expansion steps. During an uninterruptible inference call, discard its result after cancellation instead of applying it later. Failed windows must not damage successful page analysis or accepted repairs.

Record useful local diagnostics such as window dimensions, expansion count, cache usage, stage durations, cancellation, and review reasons. Avoid logging raw OCR text, translations, or chapter pixels by default.

## 15. Main risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Shared overlay breaks interaction | Preserve existing interaction contracts; test focus, selection, empty clicks, drag/resize, and active-object mounting. |
| Detector misses or misgroups seam content | Scan eligible seams independently, expand bounded windows, use conservative evidence, and provide manual region reanalysis. |
| Repair destroys existing work | Stable IDs, dedicated transactions, conflict previews, backups, and exact undo tests. |
| Raw and cleaned images do not align | Explicit per-image transforms and visible rejection of unsupported registration. |
| Large windows or image caches exhaust memory | Pixel/dimension budgets, bounded decoding, limited concurrency, cancellation, and profiling. |
| Preview and export diverge | Shared geometry contracts, document-space effects, and lossless slice-reassembly tests. |
| Schema change prevents rollback | Versioned migration, preserved original project, and documented compatibility limits. |

## 16. Execution and review checklist

- [ ] Complete Milestone 0 before treating the earlier code review as authoritative for the current branch.
- [ ] Land a regression test before each behavioral change.
- [ ] Keep commits/reviews aligned to rendering, geometry/data, OCR/reconciliation, and export/persistence hardening.
- [ ] Release the rendering fix independently when its own gates pass.
- [ ] Keep automatic seam repair behind a feature gate until state-preservation and persistence tests pass.
- [ ] Prefer existing infrastructure and avoid unrelated refactors or mandatory new dependencies.
- [ ] At each milestone, record changed files, tests run, remaining limitations, and any updated design assumptions.
- [ ] Do not claim OCR reconstruction succeeds for every chapter; report ambiguous and unsupported cases explicitly.

## 17. Final definition of done

A correctly ordered, contiguous longstrip fixture containing text across a source seam can be opened, analyzed, repaired, translated, typeset, edited, exported into different slice layouts, saved, reopened, and undone/redone without duplicated logical regions, obscured lettering, changed text layout, or lost authored content.

The chapter remains tiled in memory. The owner page no longer acts as a clipping boundary. Rendering fixes work independently of OCR repair, and uncertain repairs remain reviewable.
