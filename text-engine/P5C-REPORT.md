# P5c: four rounds, final worktree account

[M] measured by this agent; [I] inferred from code. Pre-round-one = old wasm `d200a3a0832efd84`; R2 = reviewer’s rebuilt round-two wasm `5adf5ea04b708dd5`; final = round-three trial: retained direction at every width, incoming slope length below 1e-4 discarded in one place. HEAD remains `5d73134`; no git writes. Round-three measurements live in `node_modules/.cache/p5c/r3/`; round-four proofs/mutations in `node_modules/.cache/p5c/r4/`; reviewer inputs were read in place. Unqualified Rust paths are under `text-engine/`.
Round one added budgets, retained directions, a coverage halo, a signed-region sweep and canvas placement checks. Round two replaced cumulative charges with live refunds, bounded shaping runs, removed the slow sweep/separation candidate and restored the hairline exception. Round three fixes the cap, independent guard tests, unchecked refunds, three pushes and documentation; round four ships the measured hairline trial after coordinator acceptance, with independent truth and crop mutation tests [M/I].

## 1. The limit

The 384-MiB cap refused eleven old-build jobs. Round-three lifted-cap measurements reused the reviewer’s counting allocator and instrumented R2; round four repeats it on final source at the shipped cap, each row fresh. Charged/allocator peaks exclude loaded fonts and ABI input; neither is linear-memory size or RSS. All eleven also paint with the final 1152-MiB build [M]. Page = 2500×3500 job units at scale 2, size as labelled; 2000×2800 uses size 40; editor = 1414×1414, size 20, scale 2 (40-px letters). English uses Comic Neue; Korean/Japanese use system Arial Unicode.
`src/paint/budget.rs:12` sets **1152 MiB**, the smallest 128-MiB step with at least 10% of the cap spare above the measured 1007.0-MiB maximum (12.6% spare). No listed job needs more than 1536 MiB. `mod.rs` removes both Part-record estimates (old :414/:456); the job cannot bound flattened font/stroke cost accurately for every font [I]. Known RGBA prechecks remain at `mod.rs:315` / `scene.rs:134` and have independent mutation-failing tests (item 3).

| job | glyphs | bands | MP | charged / allocator MiB | old → final max RGBA / alpha / premul |
|---|---|---|---|---|---|
| Korean page 60 | 1558 | 4 | 33.6 | 387.2 / 386.8 | 1 / 0 / 1.000 |
| Korean page 40 | 3596 | 2 | 34.5 | 396.9 / 396.9 | 0 / 0 / 0.000 |
| Korean page 40 | 3596 | 4 | 34.6 | 671.6 / 671.5 | 0 / 0 / 0.000 |
| Korean 2000x2800 | 2300 | 4 | 22.1 | 432.1 / 432.1 | 0 / 0 / 0.000 |
| Japanese page 60 | 1558 | 4 | 33.6 | 504.4 / 504.0 | 1 / 0 / 1.000 |
| Japanese page 40 | 3596 | 2 | 34.5 | 522.1 / 522.1 | 1 / 0 / 0.890 |
| Japanese page 40 | 3596 | 4 | 34.6 | 916.3 / 916.3 | 1 / 0 / 1.000 |
| English page 60 | 2850 | 4 | 30.8 | 549.2 / 549.2 | 1 / 1 / 1.000 |
| English page 40 | 6554 | 2 | 31.2 | 582.0 / 581.6 | 0 / 0 / 0.000 |
| English page 40 | 6554 | 4 | 31.3 | 1007.0 / 1006.6 | 1 / 0 / 1.000 |
| Korean editor 8 MP | 3290 | 4 | 8.0 | 473.3 / 473.1 | 40 / 40 / 40.000 |

The editor’s largest difference from pre-round-one is **40 alpha/premultiplied levels**, also measured in the unchanged R2 build with its cap lifted; this is not a new round-three pixel change. The other ten maxima are at most one level. Round four reran all eleven jobs and seven refusals: all pass, and no tabulated figure moved at the displayed precision (charged/allocator peaks included). Final changes only two of 62 R2 fixed rasters, detailed below [M].

| oversized case | result | next job |
|---|---|---|
| zoom 62 target MP, 0 bands | refused | identical |
| zoom 62 target MP, 2 bands | refused | identical |
| zoom 62 target MP, 4 bands | refused | identical |
| ASCII x16, 0 bands | refused | identical |
| ASCII x16, 2 bands | refused | identical |
| ASCII x16, 4 bands | refused | identical |
| 120000000 letters | refused | identical |

All seven refusals leave result slots zero, produce no trap and are followed by the fresh engine’s exact next-job hash [M]. The six side/pixel cases are the original zoom-62-target-MP and ASCII-x16 cases, bands 0/2/4. A 120000000-letter run is refused before shaping. Input bytes themselves are outside the painter budget [I].

## 2. The hairline rule: shipped

Final removes the width exception and retains directions at every width. Coverage at or below **1e-6** contributes nothing; incoming slopes with **gx²+gy² < 1e-8** (length < 1e-4) are unknown, floored in one place before storage or union. This is exactly the measured round-three trial. The coordinator accepted its nearer truth and crop behavior; the width-step and pre-round-one permutation gates were withdrawn. The residual 46-level Bangers step is geometry: using the old rule on both sides already gives 47 levels on two pixels. No alternative epsilon or form was tried [M/I].
Truth is 16x supersampled premultiplied coverage, averaged down; metrics are worst error / pixels over 16 / mean over inked pixels. These use e3b’s two named cases [M].

| case | band px | R2 truth error | final truth error |
|---|---|---|---|
| Bangers | 0.3 | 83 / 654 / 4.11 | 109 / 637 / 4.12 |
| Bangers | 0.6 | 100 / 959 / 5.28 | 100 / 891 / 5.05 |
| Bangers | 0.99 | 103 / 610 / 3.42 | 103 / 454 / 2.76 |
| Bangers | 1.5 | 79 / 190 / 1.38 | 79 / 190 / 1.38 |
| Bangers | 5 | 63 / 32 / 0.24 | 63 / 32 / 0.24 |
| IIII | 0.3 | 118 / 138 / 17.78 | 150 / 73 / 11.19 |
| IIII | 0.6 | 104 / 137 / 15.32 | 97 / 12 / 2.89 |
| IIII | 0.99 | 98 / 31 / 6.56 | 48 / 2 / 0.53 |
| IIII | 1.5 | 8 / 0 / 0.22 | 8 / 0 / 0.22 |
| IIII | 5 | 11 / 0 / 0.15 | 11 / 0 / 0.15 |

| 0.99 → 1.01 px | R2 max / >16 | final max / >16 |
|---|---|---|
| Bangers | 80 / 338 | 46 / 3 |
| IIII | 96 / 27 | 3 / 0 |

The e3c nonuniform/mirrored/sheared cases use 12x truth; line width 0.6 job units. Below are R2 and final truth errors; final uses one rule for every transform and width [M].

| case | transform | R2 truth error | final truth error |
|---|---|---|---|
| Bangers | scale 1.6 | 91 / 581 / 4.20 | 91 / 434 / 3.39 |
| Bangers | mirror -1.6 | 91 / 581 / 4.20 | 91 / 434 / 3.39 |
| Bangers | scale 1.7 by 0.6 | 145 / 561 / 8.37 | 145 / 551 / 8.09 |
| Bangers | scale 0.6 by 1.7 | 142 / 886 / 12.01 | 142 / 874 / 11.47 |
| Bangers | scale 3 by 0.5 | 134 / 801 / 8.19 | 130 / 777 / 7.99 |
| Bangers | shear x by 1.2 at 1.3 | 108 / 966 / 7.76 | 108 / 966 / 7.76 |
| IIII | scale 1.6 | 64 / 71 / 8.04 | 26 / 2 / 0.60 |
| IIII | mirror -1.6 | 64 / 71 / 8.04 | 26 / 2 / 0.60 |
| IIII | scale 1.7 by 0.6 | 120 / 6 / 4.67 | 120 / 6 / 4.67 |
| IIII | scale 0.6 by 1.7 | 92 / 94 / 20.36 | 92 / 94 / 20.36 |
| IIII | scale 3 by 0.5 | 118 / 12 / 7.25 | 118 / 12 / 7.25 |
| IIII | shear x by 1.2 at 1.3 | 59 / 106 / 13.01 | 59 / 106 / 13.01 |

Cut scene versus larger-scene crop, 40 seeded three-letter scenes per set, 64-px margin (e3e/e3i). Cells are differing pixels / maximum alpha delta. Final fixes every hairline maximum to ≤1; fills and wide bands remain ≤1 [M].

| letters / glyph px | fill R2 → final | wide R2 → final | 0.75 px R2 → final |
|---|---|---|---|
| straight / 32 | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 | 2 / 23 → 0 / 0 |
| straight / 128 | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 | 68 / 46 → 60 / 1 |
| straight / 384 | 1 / 1 → 1 / 1 | 16 / 1 → 16 / 1 | 183 / 37 → 175 / 1 |
| round / 32 | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 | 3 / 1 → 3 / 1 |
| round / 128 | 8 / 1 → 8 / 1 | 0 / 0 → 0 / 0 | 47 / 56 → 38 / 1 |
| round / 384 | 15 / 1 → 15 / 1 | 0 / 0 → 0 / 0 | 38 / 40 → 29 / 1 |

q4: every permutation, all 48 rows; cells are worst alpha delta / worst count over 16. I3/I4/I5 = I parts 0.2 apart; O4 = OXVW 3 apart; O5 = OXVWA 5 apart; A5 = AVAVA 9 apart. D/B = DejaVu/Bangers. Final retains order dependence in hairlines where three or more parts share pixels; text order is fixed in real jobs. These are stated limits, not acceptance gates [M].

| parts / font / bands | pre-round-one | R2 | final |
|---|---|---|---|
| I3 / D / none | 4 / 0 | 0 / 0 | 0 / 0 |
| I3 / D / band | 14 / 0 | 0 / 0 | 0 / 0 |
| I3 / D / hair | 62 / 7 | 62 / 7 | 21 / 53 |
| I3 / D / two | 10 / 0 | 0 / 0 | 0 / 0 |
| I4 / D / none | 11 / 0 | 1 / 0 | 1 / 0 |
| I4 / D / band | 14 / 0 | 1 / 0 | 1 / 0 |
| I4 / D / hair | 41 / 7 | 41 / 7 | 52 / 4 |
| I4 / D / two | 12 / 0 | 4 / 0 | 4 / 0 |
| I5 / D / none | 10 / 0 | 1 / 0 | 1 / 0 |
| I5 / D / band | 14 / 0 | 1 / 0 | 1 / 0 |
| I5 / D / hair | 27 / 4 | 27 / 4 | 42 / 5 |
| I5 / D / two | 16 / 0 | 13 / 0 | 13 / 0 |
| O4 / D / none | 30 / 2 | 8 / 0 | 8 / 0 |
| O4 / D / band | 31 / 3 | 6 / 0 | 6 / 0 |
| O4 / D / hair | 61 / 50 | 55 / 32 | 91 / 24 |
| O4 / D / two | 20 / 3 | 9 / 0 | 9 / 0 |
| O5 / D / none | 22 / 7 | 7 / 0 | 7 / 0 |
| O5 / D / band | 26 / 6 | 14 / 0 | 14 / 0 |
| O5 / D / hair | 63 / 59 | 57 / 45 | 85 / 36 |
| O5 / D / two | 23 / 4 | 8 / 0 | 8 / 0 |
| A5 / D / none | 20 / 6 | 3 / 0 | 3 / 0 |
| A5 / D / band | 31 / 8 | 2 / 0 | 2 / 0 |
| A5 / D / hair | 52 / 28 | 52 / 13 | 63 / 12 |
| A5 / D / two | 20 / 7 | 9 / 0 | 9 / 0 |
| I3 / B / none | 14 / 0 | 1 / 0 | 1 / 0 |
| I3 / B / band | 14 / 0 | 11 / 0 | 11 / 0 |
| I3 / B / hair | 46 / 75 | 46 / 75 | 21 / 1 |
| I3 / B / two | 14 / 0 | 1 / 0 | 1 / 0 |
| I4 / B / none | 18 / 4 | 3 / 0 | 3 / 0 |
| I4 / B / band | 17 / 6 | 15 / 0 | 15 / 0 |
| I4 / B / hair | 40 / 76 | 40 / 76 | 68 / 14 |
| I4 / B / two | 17 / 5 | 1 / 0 | 1 / 0 |
| I5 / B / none | 18 / 2 | 4 / 0 | 4 / 0 |
| I5 / B / band | 17 / 5 | 17 / 1 | 17 / 1 |
| I5 / B / hair | 40 / 60 | 40 / 60 | 92 / 24 |
| I5 / B / two | 17 / 6 | 2 / 0 | 2 / 0 |
| O4 / B / none | 26 / 4 | 13 / 0 | 13 / 0 |
| O4 / B / band | 20 / 3 | 6 / 0 | 6 / 0 |
| O4 / B / hair | 60 / 37 | 56 / 29 | 90 / 20 |
| O4 / B / two | 22 / 2 | 6 / 0 | 6 / 0 |
| O5 / B / none | 19 / 1 | 10 / 0 | 10 / 0 |
| O5 / B / band | 20 / 2 | 5 / 0 | 5 / 0 |
| O5 / B / hair | 59 / 29 | 50 / 19 | 85 / 18 |
| O5 / B / two | 21 / 4 | 9 / 0 | 9 / 0 |
| A5 / B / none | 6 / 0 | 5 / 0 | 5 / 0 |
| A5 / B / band | 3 / 0 | 3 / 0 | 3 / 0 |
| A5 / B / hair | 52 / 2 | 52 / 2 | 49 / 2 |
| A5 / B / two | 13 / 0 | 3 / 0 | 3 / 0 |

For truth across permutations, old rule means R2’s removed hairline exception. Truth was rendered for each individual permutation. Each error column takes the worst max, >16 count and mean independently across permutations; nearer/tied/farther compares means for matching permutations [M].

| hairline parts | font | orders | R2 old-rule truth max / >16 / mean | final truth max / >16 / mean | nearer / tied / farther |
|---|---|---|---|---|---|
| III 0.2 apart | DejaVu | 6 | 109.9 / 74 / 24.093 | 107.9 / 57 / 12.445 | 6 / 0 / 0 |
| IIII 0.2 apart | DejaVu | 24 | 110.9 / 45 / 14.696 | 108.9 / 9 / 6.399 | 24 / 0 / 0 |
| IIIII 0.2 apart | DejaVu | 120 | 127.3 / 20 / 10.880 | 108.9 / 11 / 5.247 | 120 / 0 / 0 |
| OXVW 3 apart | DejaVu | 24 | 91.6 / 97 / 5.461 | 90.6 / 99 / 5.543 | 6 / 0 / 18 |
| OXVWA 5 apart | DejaVu | 120 | 119.5 / 150 / 7.371 | 110.5 / 148 / 7.213 | 72 / 0 / 48 |
| AVAVA 9 apart | DejaVu | 120 | 91.6 / 91 / 5.152 | 91.6 / 92 / 5.114 | 26 / 0 / 94 |
| III 0.2 apart | Bangers | 6 | 94.7 / 83 / 22.531 | 94.7 / 31 / 10.266 | 6 / 0 / 0 |
| IIII 0.2 apart | Bangers | 24 | 94.7 / 84 / 24.148 | 90.5 / 34 / 10.191 | 24 / 0 / 0 |
| IIIII 0.2 apart | Bangers | 120 | 108.7 / 86 / 24.550 | 86.1 / 39 / 9.480 | 120 / 0 / 0 |
| OXVW 3 apart | Bangers | 24 | 102.9 / 104 / 7.291 | 100.9 / 104 / 7.088 | 18 / 0 / 6 |
| OXVWA 5 apart | Bangers | 120 | 107.5 / 111 / 6.157 | 107.5 / 106 / 6.212 | 16 / 0 / 104 |
| AVAVA 9 apart | Bangers | 120 | 89.4 / 50 / 3.103 | 89.4 / 47 / 2.955 | 120 / 0 / 0 |

Final versus all 62 R2 fixed rasters (e3a method): only the following change. All other 60 are byte-identical; no changed job is a net loss [M].

| rule / job | changed | nearer / farther / tied | mean R2 → final | max step | R2 → final hash |
|---|---|---|---|---|---|
| unchanged / overlapping letters | 12 | 9 / 2 / 1 | 0.770 -> 0.230 | 1 | 9d938a39bcdd7316 → dd68c535e1ed2430 |
| webkit / overlapping letters | 12 | 9 / 2 / 1 | 0.770 -> 0.230 | 1 | 9d938a39bcdd7316 → dd68c535e1ed2430 |

`mirrored` is unchanged by final: against pre-round-one it remains **1 nearer / 2 farther**, mean 2.8 → 8.4 on three changed pixels, max loss 15 (round-three 16x truth). Final does not mend that R2 net loss. Hairline coverage with three or more parts remains approximate: the truth table shows maxima up to 150 and mean up to 11.19; q4 hairline order deltas reach 92 levels. Opposite-winding cancellation also remains (section 5). The two new tests defend nearer truth and stable crops, with independent failing mutations below [M/I].

## 3. Tests that fail on their individual removal

Round-three guard mutations and round-four hairline mutations were compiled and run in a scratch source copy; no production source was mutated. Each new test passes in the restored full suite and fails by assertion/panic, not a compilation error, when its own behavior is removed (exit 101) [M].

| mutation / production site | test | result |
|---|---|---|
| iterator-refund | owned_iterator_refunds_only_when_dropped | FAILED, exit 101 |
| buffer-account | buffer_from_an_earlier_scope_is_charged_to_this_one | FAILED, exit 101 |
| wire-run-limit | decode_alone_refuses_a_run_over_the_wire_limit | FAILED, exit 101 |
| job-run-limit | job_run_limit_precedes_work_on_any_earlier_run | FAILED, exit 101 |
| rollback | a_refused_line_rolls_back_the_glyphs_already_appended | FAILED, exit 101 |
| line-scope | add_line_opens_its_own_budget_scope | FAILED, exit 101 |
| raster-precheck | raster_bytes_are_refused_before_preparing_edges | FAILED, exit 101 |
| scene-precheck | scene_raster_bytes_are_refused_before_generating_bands | FAILED, exit 101 |
| restore hairline exception (floor kept) | four_hairline_parts_stay_near_supersampled_truth | FAILED, mean 15.322 ≥ 4, exit 101 |
| remove incoming slope floor | hairline_crop_ignores_rounding_noise_in_incoming_slopes | FAILED, crop delta 55 > 1, exit 101 |

Owned iterator refund is `budget.rs:210`, adoption `:138`, wire run limit `job.rs:341`, whole-job run limit `mod.rs:386`, rollback `scene.rs:89`, own Scope `:71`. Rollback mutation leaves 32 glyphs instead of 1; Scene precheck mutation raises peak to 13968 instead of 768 bytes. Scope test opens no surrounding Scope: a test-only next-scope limit makes `add_line` refuse, then the next line paints. The raster test uses a rasterizer that panics if preparation precedes refusal [M/I]. Removed Part prechecks have no replacement; the remaining real-cost guards each have a failing mutation [I].

## 4. The budget’s soft spots

`budget.rs:110` refunds with saturating subtraction and a debug assertion that bytes never exceed the live charge. `shape.rs:83`, `raster.rs:257`, `mod.rs:412` push through `budget::push`, so future growth is checked and charged rather than merely trusting prior reserves [I]. Buffer’s existing interface is retained; it was not redesigned. Live-capacity/drop, overflow, owned-iterator and adoption tests pass in both paint configurations [M].

## 5. Words and what remains limited

`raster.rs` describes absolute pixel-integrated signed sums and cancellation within mixed-winding parts. `RULES.md` **rule 12** states signed-area sum, measured cancellation errors, cosine union with retained slopes at every width, 1e-6 coverage gate and 1e-8 incoming squared-slope floor, remaining hairline truth/order limits, surface bounds, 1152-MiB cap and 262144-byte run limit [I].
Opposite rectangles still read 0.2 rather than 0.8 (153 alpha levels wrong); the L notch reads 0.740/0.600 versus about 0.838/0.797 (25/50 levels wrong), measured in round two. The sweep was removed after reviewer measurements of 3–20x slowdowns; the contour-separation candidate preserved 62 rasters but failed 1.05 (up to 1.461x on French fill). Neither is restored [M/I].
`js/paint.mjs:45` now says -5 also means “the job is over the painter’s memory or run limit.” `src/lib/text-engine/rust-painter.js:50` already propagates that error; it contained no old wording. Its engine test now asserts the run-limit message and that the next canvas job paints [M/I].

## Proof: all run here

| configuration | cargo test | clippy --all-targets -- -D warnings | fmt --check |
|---|---|---|---|
| default | 117 passed | passed | passed |
| --no-default-features | 30 passed | passed | passed |
| --features raster-compare | 117 passed | passed | passed |

`npm run build:engine`: **1559527 B**, sha256 **1c6e5e3fd3007e60e70698e16ec5117c72380e020d6aa9d50a487c346c9bcbcc** [M]. `MT_TEXT_PAINT_OUT=node_modules/.cache/p5c node text-engine/parity/paint-hash.mjs --native`: **3b4ed868eecb1fa5**, all 62 native/wasm rasters agree. Against R2 **5adf5ea04b708dd5**, only `overlapping letters` under unchanged/webkit changes: 12 pixels each, max one level, 9 nearer / 2 farther / 1 tied, mean changed-pixel error 0.770 → 0.230; the other 60 rasters are byte-identical. Default, oz, SIMD and comparison builds agree in both processes; supporting builds were refreshed for this proof. Build and parity scratch use CARGO_TARGET_DIR under p5c [M].

Vitest: `./node_modules/.bin/vitest run src/lib/text-engine` — Test Files  6 passed (6) Tests  110 passed (110) [M].

`node text-engine/parity/raster.mjs` (MT_TEXT_PAINT_OUT under p5c): the same 32x truth method as round two; final table below. Against round three, only exact’s 0.6-px >16 rate moves: 24.24 → 24.20 per 1000 (−0.04); every other displayed quality metric is unchanged. Cells are levels / mean / p99 / max / >16 per 1000 / lost / bias%. Full four-rasterizer tables are in `r3/raster.log` and `r4/raster.log` [M].

| case (round-three delta stated above) | exact | tiny-skia | zeno | vello |
|---|---|---|---|---|
| fill, 8 to 14 px | 256 / 0.68 / 2.4 / 72.4 / 0.23 / 0 / -0.10 | 29 / 8.21 / 30.6 / 59.6 / 135.87 / 222 / 0.16 | 256 / 0.96 / 2.9 / 73.4 / 0.23 / 0 / -0.18 | 256 / 0.67 / 2.3 / 73.4 / 0.23 / 0 / -0.08 |
| fill, 22 to 96 px | 256 / 0.70 / 2.6 / 15.7 / 0.00 / 0 / -0.02 | 29 / 7.52 / 28.8 / 47.7 / 118.34 / 396 / -0.01 | 256 / 1.05 / 3.4 / 68.7 / 0.25 / 0 / -0.04 | 256 / 0.70 / 2.5 / 68.7 / 0.25 / 0 / -0.02 |
| stroke 0.6 px wide, text 10 to 44 px | 256 / 1.54 / 29.8 / 107.2 / 24.20 / 0 / 0.71 | 29 / 9.96 / 39.0 / 72.2 / 195.95 / 408 / 0.02 | 256 / 2.16 / 36.7 / 118.7 / 33.56 / 0 / 1.07 | 256 / 1.87 / 36.5 / 116.7 / 33.59 / 0 / 1.26 |
| stroke 1.5 px wide, text 10 to 14 px | 256 / 2.48 / 40.5 / 96.1 / 38.80 / 0 / 0.47 | 29 / 7.76 / 28.7 / 52.3 / 119.35 / 104 / -0.02 | 256 / 4.85 / 48.2 / 104.5 / 92.86 / 0 / 1.31 | 256 / 4.63 / 47.8 / 104.5 / 91.19 / 0 / 1.33 |
| stroke 12 px wide, text 44 px (strokes of neighbours overlap) | 256 / 1.43 / 17.9 / 79.5 / 11.30 / 0 / -0.01 | 29 / 7.22 / 28.6 / 34.9 / 115.71 / 210 / -0.04 | 256 / 2.03 / 34.9 / 86.1 / 20.69 / 0 / 0.01 | 256 / 1.76 / 33.6 / 84.1 / 20.50 / 0 / 0.01 |
| synthetic bold fill, 12 and 44 px | 256 / 0.88 / 9.1 / 59.3 / 4.64 / 0 / 0.00 | 29 / 7.90 / 29.8 / 37.6 / 126.93 / 159 / 0.04 | 256 / 1.21 / 10.6 / 87.3 / 5.77 / 0 / -0.01 | 256 / 0.89 / 10.2 / 88.3 / 5.63 / 0 / 0.02 |

## Speed against R2

Alternating engine order, 30 paired warm-ups then 40 samples of eight paints; one-minute `uptime` load checked before every warm-up and timed pair, and after every pair; samples at ≥6 discarded. No compilation or truth process ran concurrently. These round-three ratios are median R3 control/R2 and final-rule/R2 (then called trial); final ships that exact rule. Fixed jobs use the default webkit rule. Two control outliers were repeated with 60 warm-ups, 120 samples of 20 paints; initial and repeat values are both retained [M].

| job / bands | R3 control/R2 median | final/R2 median |
|---|---|---|
| French Comic 0 | 1.028 | 1.008 |
| French Comic 1 | 1.030 | 1.008 |
| French Comic 2 | 1.026 | 1.011 |
| French DejaVu 0 | 1.013 | 1.011 |
| French DejaVu 1 | 1.024 | 1.010 |
| French DejaVu 2 | 1.033 | 1.009 |
| Japanese 0 | 1.016 | 1.015 |
| Japanese 1 | 1.023 | 1.012 |
| Japanese 2 | 1.026 | 1.021 |
| Korean 0 | 1.005 | 1.012 |
| Korean 1 | 1.014 | 1.005 |
| Korean 2 | 1.018 | 1.011 |
| solid | 1.021 | 0.991 |
| solid, 11.5 px, 1x | 1.029 | 1.012 |
| two bands | 1.017 | 1.005 |
| hairline | 1.030 | 1.021 |
| linear | 1.014 | 1.009 |
| radial | 0.999 | 1.005 |
| per line | 1.020 | 1.002 |
| pattern | 1.010 | 1.013 |
| pattern, shrunk | 1.004 | 1.002 |
| curved | 1.017 | 1.013 |
| curved, pattern, bold | 1.016 | 1.001 |
| silhouette | 1.030 | 1.017 |
| silhouette, curved | 1.028 | 1.017 |
| letter spacing | 1.023 | 0.989 |
| bold italic | 1.026 | 1.007 |
| its own oblique | 1.006 | 1.009 |
| rotated | 1.024 | 1.010 |
| mirrored | 1.029 | 1.012 |
| sheared, 3.3x | 1.012 | 1.012 |
| nothing | 1.002 | 1.064 |
| tab and newline | 1.003 | 1.007 |
| fallback | 1.017 | 1.004 |
| fallback, bold, spaced | 1.008 | 1.018 |
| bold, smeared | 1.017 | 1.016 |
| bold italic, smeared, rotated | 1.075 → 1.013 repeat | 0.995 |
| curved, bold, smeared | 1.019 | 1.011 |
| bold, outset named | 1.024 | 1.009 |
| overlapping letters | 1.032 | 1.016 |
| weight 0.4 | 1.026 | 1.005 |
| weight 0.4, small, rotated | 1.059 → 1.043 repeat | 1.018 |
| weight 1.25, silhouette, bold | 1.016 | 1.010 |

The final rule’s round-three timings are within 1.05 for all paragraphs and painted fixed jobs; `nothing` reads 1.064. R3 control’s initial 1.075/1.059 outliers repeated at 1.013/1.043; scheduling/tiering noise is inferred, not proved. Timed load ranges and median/minimum times remain in the logs. Some hairline permutations are farther from truth (counts above); their small mean differences remain documented limits, and the coordinator accepts the final rule [M/I].
No fonts added or downloaded; system Arial Unicode read in place. Nothing from tp-data copied into the repository. No git writes, plugins, skills, sweep, separation, rasterizer replacement, Buffer redesign, weight/placement/compositing changes, or alternative epsilon search. Mutations only in scratch copies; reviewer source and scratch remain untouched. The measured trial is now shipped, including its slope floor and better crop behavior [M/I]. No new browser capture or full application-wide JS-suite run was made; the requested engine suite ran (6 files, 110 tests).
