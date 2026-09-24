<script>
  import {
    app,
    byId,
    boxText,
    deleteBox,
    markUnsaved,
    beginEdit,
    rememberStyle,
    cloneStyle,
    fontCssFor,
    page,
    pageById,
    setEditSettleHook,
    boxOwnText,
    setBoxText,
    isFreeBox,
    autoFitBox,
    refitBalloon,
    toast,
    resizeBox,
  } from './store.svelte.js';

  import { record } from './editor/history.svelte.js';
  import { fontGroups, isFontOffered } from './font-menu.js';
  import { modKey } from './format.js';
  import {
    PATTERN_KINDS,
    GRADIENT_MAX_STOPS,
    defaultPathPts,
    WARP_MIN_GRID,
    WARP_MAX_GRID,
    WARP_MESH_DEFAULT,
  } from './data.js';
  import { gradientCss, patternTileCanvas, sampleStops } from './text-paint.js';
  import { insertPathAnchor } from './measure.js';
  import { maskTool, setMaskTool } from './mask-tool.svelte.js';
  import { regridWarp } from './warp-gizmo.js';
  import { liquifyTool, setLiquifyMode, LIQUIFY_RADIUS_MIN, LIQUIFY_RADIUS_MAX } from './liquify-tool.svelte.js';
  import { LIQUIFY_MODES } from './liquify.js';
  import BrushPanel from './BrushPanel.svelte';
  import { brushArmed } from './brush-tool.svelte.js';
  import { prefs } from './prefs.svelte.js';
  // Which tab is open is session state shared with the keyboard - see
  // inspector-tabs.svelte.js. The panel is one of two writers, not the owner.
  import {
    inspectorTab,
    setInspectorTab,
    effectsSubTab,
    setEffectsSubTab,
  } from './inspector-tabs.svelte.js';
  import { presets, savePreset, removePreset } from './presets.svelte.js';
  import {
    tabIcons,
    effectsSubTabIcons,
    iconRotate,
    iconGradientLinear,
    iconGradientRadial,
    iconArrowUp,
  } from './tab-icons.js';
  import {
    createFieldUndo,
    recordFieldEdit,
    resyncField,
    undoField,
    redoField,
    caretAfter,
    isAtomicInput,
  } from './editor/field-undo.svelte.js';
  import { onDestroy } from 'svelte';

  const box = $derived(app.selectedId ? byId(app.selectedId) : null);

  // Four tabs across the top, one job each. What used to be five stacked
  // accordions in one scroll is now four panels the height of the panel: the
  // controls did not change, only how many of them are in front of you at once.
  const TABS = [
    ['text', 'Text'],
    ['fill', 'Fill'],
    ['effects', 'Effects'],
    ['layout', 'Layout'],
  ];
  const tab = $derived(inspectorTab.id);
  const setTab = setInspectorTab;

  // WAI-ARIA tabs: roving tabindex, Left/Right move and activate, Home/End
  // jump to the ends. The pane takes role=tabpanel and is named by its tab.
  function onTabKey(e, id) {
    const i = TABS.findIndex(([t]) => t === id);
    let n = null;
    if (e.key === 'ArrowLeft') n = (i + TABS.length - 1) % TABS.length;
    else if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = TABS.length - 1;
    if (n == null) return;
    e.preventDefault();
    const next = TABS[n][0];
    setTab(next);
    document.getElementById(`insp-tab-${next}`)?.focus();
  }

  const EFFECTS_TABS = [
    ['stroke', 'Stroke'],
    ['shadow', 'Shadow'],
    ['warp', 'Warp'],
    // Not the same thing as the one above it, and the two labels are the only
    // place that says so to the user: `warp` bends the BASELINE (arc, circle,
    // bezier path), `transform` deforms the whole finished box through a mesh.
    ['transform', 'Transform'],
    // The same mesh as `transform`, pushed with a round tool instead of dragged
    // by its handles - which is why it works on type and ink alike.
    ['liquify', 'Liquify'],
    ['blur', 'Blur'],
    ['edges', 'Edges'],
    ['mask', 'Mask'],
  ];

  function onSubTabKey(e, id) {
    const i = EFFECTS_TABS.findIndex(([t]) => t === id);
    let n = null;
    if (e.key === 'ArrowLeft') n = (i + EFFECTS_TABS.length - 1) % EFFECTS_TABS.length;
    else if (e.key === 'ArrowRight') n = (i + 1) % EFFECTS_TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = EFFECTS_TABS.length - 1;
    if (n == null) return;
    e.preventDefault();
    const next = EFFECTS_TABS[n][0];
    setEffectsSubTab(next);
    document.getElementById(`insp-subtab-${next}`)?.focus();
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  // Percentages are what the panel shows for every 0..1 alpha; the style keeps
  // the fraction.
  const pct = (v) => Math.round((v ?? 0) * 100);

  // Debounce history recording during continuous adjustments.
  const SETTLE_MS = 400;
  let pending = null;
  let settleT;

  // Capture style, transform geometry, and text for undo history.
  const snapOf = (b) => ({
    style: cloneStyle(b.style),
    text: boxOwnText(b),
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
  });
  const geomOf = (snap) => {
    const g = { x: snap.x, y: snap.y, w: snap.w, h: snap.h };
    if (snap.style?.ink?.on) g.ink = structuredClone(snap.style.ink);
    return g;
  };

  const fitOf = (snap) => ({ y: snap.y, h: snap.h });

  // The box as it stood BEFORE the change `touch` is being told about. Every
  // handler in this panel mutates first and calls `touch` after, so a snapshot
  // taken inside `touch` is already the after - and a one-click edit (a
  // switch, a mode button) then diffed as before === after and recorded
  // nothing: single-click changes were simply not undoable, and a slider
  // burst lost its first tick. So the snapshot is taken where the change has
  // provably not happened yet: a capture-phase pointerdown/keydown on the
  // panel itself, which runs before any control's own handler. `armSnap`
  // refreshes it only while no entry is pending - two edits inside one settle
  // window are one burst, and the burst diffs against its own start.
  let preSnap = null;
  function armSnap() {
    if (!box) return;
    if (pending && pending.boxId === box.id) return;
    preSnap = { boxId: box.id, snap: snapOf(box) };
  }

  // Explicit geometry edits record resize history.
  function touch(opts) {

    if (pending && pending.boxId !== box?.id) settle();

    if (box && !pending) {
      pending = {
        pageId: page().id,
        boxId: box.id,
        before: preSnap?.boxId === box.id ? preSnap.snap : snapOf(box),
      };
    }
    if (pending && opts?.geom) pending.geom = true;
    if (box) autoFitBox(box);
    markUnsaved();
    rememberStyle(box);
    clearTimeout(settleT);
    settleT = setTimeout(settle, SETTLE_MS);
  }

  // Hook to settle pending edits on navigation or undo.
  const releaseSettleHook = setEditSettleHook(settle);
  onDestroy(() => {
    // Settle pending changes on panel unmount, then release the hook so a
    // later settle cannot record against whatever document is open by then.
    settle();
    releaseSettleHook();
    clearTimeout(settleT);
    // The delete-preset arming timer too. It is one 2.5s timer rather than a
    // leak that grows, but it holds this component's closure past its unmount
    // and then writes `delArm` - state belonging to an Inspector that is no
    // longer on screen.
    clearTimeout(delArmT);
    pending = null;
  });

  function settle() {
    clearTimeout(settleT);
    const pend = pending;
    pending = null;
    // The armed snapshot served the burst that just closed. Cleared so a later
    // mutation that somehow arrives without its own pointerdown/keydown (a
    // scripted write, a test) falls back to a fresh snapshot instead of
    // blaming this burst's start for changes it never saw.
    preSnap = null;
    if (!pend) return;
    // Ignore pending edits for previous pages.
    if (pend.pageId !== page().id) return;

    const b = pageById(pend.pageId)?.boxes.find((x) => x.id === pend.boxId);
    if (!b) return;
    const before = pend.before;
    const after = snapOf(b);
    const key = { pageId: pend.pageId, boxId: b.id };
    // Record style edit with before/after geometry.
    const fit = { geomBefore: fitOf(before), geomAfter: fitOf(after) };
    const geomChanged = pend.geom && ['x', 'y', 'w', 'h'].some((k) => before[k] !== after[k]);
    const styleOnlyInk = () => {
      const s1 = { ...before.style, ink: null };
      const s2 = { ...after.style, ink: null };
      return JSON.stringify(s1) === JSON.stringify(s2);
    };
    if (JSON.stringify(before.style) !== JSON.stringify(after.style)) {
      if (!geomChanged || !styleOnlyInk()) {
        record({ t: 'style', ...key, before: before.style, after: after.style, ...fit });
      }
    }

    if (geomChanged) {
      record({ t: 'resize', ...key, before: geomOf(before), after: geomOf(after) });
    }

    if (before.text !== after.text) {
      record({ t: 'text', ...key, before: before.text ?? null, after: after.text, ...fit });
    }
  }

  // One setter for every plain numeric field: clamp, write, touch. Saves the
  // panel from spelling the same three lines out forty times.
  function setNum(obj, key, v, lo, hi, round = false) {
    let n = +v;
    if (!Number.isFinite(n)) n = 0;
    n = clamp(n, lo, hi);
    obj[key] = round ? Math.round(n) : n;
    touch();
  }

  // Typed entry into a number field commits on change/blur rather than on
  // every keystroke: live coercion would turn a half-typed "-" or a cleared
  // field into 0 under the caret mid-entry (the NaN→0 above), which is what
  // makes negative values untypable. Spinner clicks and arrow keys fire
  // change per step, so scrubbing stays live. The field is rewritten from the
  // style afterwards, so a clamped or rejected edit never lingers in it.
  function commitNum(obj, key, e, lo, hi, round = false) {
    const el = e.target;
    let n = +el.value;
    if (!Number.isFinite(n)) n = 0;
    n = clamp(n, lo, hi);
    obj[key] = round ? Math.round(n) : n;
    el.value = String(obj[key]);
    touch();
  }
  // A mesh grid stepper, which cannot be `commitNum`: writing `cols` on its own
  // would leave `pts` the wrong length for the grid it now names, and the
  // sanitiser's answer to that is to throw the whole mesh away (it has to be -
  // a mesh missing a control point is torn, not coarse). So the block is
  // replaced whole, with the deformation carried onto the new grid by
  // `regridWarp`. One history step per change, through the panel's own settle.
  function setGrid(st, key, e) {
    const el = e.target;
    const now = st.warp[key];
    let n = Math.round(+el.value);
    if (!Number.isFinite(n)) n = now;
    n = clamp(n, WARP_MIN_GRID, WARP_MAX_GRID);
    el.value = String(n);
    if (!box || n === now) return;
    st.warp = regridWarp(st.warp, key === 'cols' ? n : st.warp.cols, key === 'rows' ? n : st.warp.rows, box.w, box.h);
    touch();
  }
  // Free is the one-cell mesh - four corner handles and a perspective map -
  // and Mesh is any grid. The two are one setting read two ways, so switching
  // is a regrid: Free keeps the corners of whatever grid it came from, Mesh
  // comes up at the default lattice with the perspective carried onto it.
  const warpIsFree = (st) => st.warp.cols === 1 && st.warp.rows === 1;
  function setWarpMode(st, free) {
    if (!box || warpIsFree(st) === free) return;
    const n = free ? 1 : WARP_MESH_DEFAULT;
    st.warp = regridWarp(st.warp, n, n, box.w, box.h);
    touch();
  }

  // The same commit-on-change for the placement fields, which write the box's
  // own geometry rather than its style.
  function commitGeom(key, e, lo, hi, fallback) {
    const el = e.target;
    let n = +el.value;
    if (!Number.isFinite(n)) n = fallback ?? lo;
    const val = clamp(n, lo, hi);
    resizeBox(page().id, box.id, { [key]: val });
    el.value = String(Math.round(box[key]));
    touch({ geom: true });
  }

  // And for alpha fields, which read percent and store a fraction.
  function commitAlpha(obj, key, e) {
    const el = e.target;
    obj[key] = clamp((+el.value || 0) / 100, 0, 1);
    el.value = String(Math.round(obj[key] * 100));
    touch();
  }
  // Alpha fields are edited in percent and stored as a fraction.
  function setAlpha(obj, key, v) {
    obj[key] = clamp((+v || 0) / 100, 0, 1);
    touch();
  }

  function setSize(v) {
    box.style.size = clamp(+v || 6, 6, 200);
    touch();
  }

  // The sizes a letterer actually picks, as a menu. The slider went with the
  // accordions: nobody scrubs for 26px, they choose it - and autofit writes
  // fractional sizes this menu would otherwise have no way to show, so whatever
  // the box is at right now is always in the list.
  const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 44, 48, 56, 64, 72];
  const sizeNow = $derived(box ? Math.round(box.style.size * 10) / 10 : 0);
  const sizeList = $derived(
    SIZES.includes(sizeNow) ? SIZES : [...SIZES, sizeNow].sort((a, b) => a - b),
  );

  function wrap180(v) {
    return (((v + 180) % 360) + 360) % 360 - 180;
  }
  function setRotation(v) {
    box.style.rotation = clamp(Math.round(+v || 0), -180, 180);
    touch();
  }
  function rotateBy(d) {
    box.style.rotation = wrap180(Math.round(box.style.rotation + d));
    touch();
  }
  function setText(v) {

    setBoxText(box, v);
    touch();
  }

  // Text field maintains its own undo stack.
  const fieldUndo = createFieldUndo();

  let fieldOwner = null;

  // Resync undo stack when box or text changes externally.
  $effect(() => {
    const id = box?.id ?? null;
    const v = box ? boxText(box) : '';
    if (id === fieldOwner && v === fieldUndo.stack[fieldUndo.i]) return;
    fieldOwner = id;
    resyncField(fieldUndo, v);
  });

  function onTextInput(e) {
    recordFieldEdit(fieldUndo, e.target.value, { atomic: isAtomicInput(e.inputType) });
    setText(e.target.value);
  }

  function onTextKey(e) {
    if (!(e.metaKey || e.ctrlKey) || (e.key !== 'z' && e.key !== 'Z')) return;
    // Intercept Cmd+Z/Shift+Cmd+Z for field undo.
    e.preventDefault();
    const next = e.shiftKey ? redoField(fieldUndo) : undoField(fieldUndo);
    if (next == null) return;
    const el = e.currentTarget;
    const caret = caretAfter(el.value, next);

    el.value = next;
    el.setSelectionRange(caret, caret);

    setText(next);
  }

  // Validate CSS hex color strings.
  const HEX = /^#?(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const HEX_MSG = 'Not a hex colour - use 3, 4, 6 or 8 hex digits, like #ff00aa';

  // An invalid value is flagged in place, not reverted: silently putting the
  // old colour back reads as the field eating your text. The warning wears
  // off on the next valid value.
  function hexFlag(el, bad) {
    if (!el) return;
    el.classList.toggle('hex-bad', !!bad);
    if (bad) el.title = HEX_MSG;
    else el.removeAttribute('title');
  }
  // Live while typing, so the border turns as soon as the text stops being a
  // colour and turns back the moment it is one again.
  function hexInput(e) {
    const el = e.target;
    hexFlag(el, el.value !== '' && !HEX.test(el.value));
  }

  function setHex(obj, key, v, el) {
    const raw = String(v ?? '').trim();
    if (HEX.test(raw)) {
      obj[key] = raw.startsWith('#') ? raw : '#' + raw;
      touch();
      hexFlag(el, false);
    } else {
      hexFlag(el, true);
    }
  }

  // ---- fill mode ----
  // Three exclusive looks over two independent flags, because the renderer
  // needs both (pattern beats gradient when both are on) and the user needs
  // one choice.
  const fillMode = $derived(box ? (box.style.pattern.on ? 'pattern' : box.style.gradient.on ? 'gradient' : 'solid') : 'solid');
  function setFillMode(m) {
    box.style.gradient.on = m === 'gradient';
    box.style.pattern.on = m === 'pattern';
    touch();
  }

  // ---- gradient ----
  function setGradKind(k) {
    box.style.gradient.kind = k;
    touch();
  }

  // The eight-way pad, laid out as it reads: the cell's position IS the
  // direction. Angles are the style's own CSS degrees (0 = bottom→top), so
  // picking a cell writes the same field the number beside it does.
  const DIRS = [
    { a: 315, n: 'Up left' },
    { a: 0, n: 'Up' },
    { a: 45, n: 'Up right' },
    { a: 270, n: 'Left' },
    null,
    { a: 90, n: 'Right' },
    { a: 225, n: 'Down left' },
    { a: 180, n: 'Down' },
    { a: 135, n: 'Down right' },
  ];
  function setAngle(a) {
    box.style.gradient.angle = ((Math.round(a) % 360) + 360) % 360;
    touch();
  }

  // The same nine cells for a radial centre, with the corners left out: a
  // gradient centred on a corner of a line of text is a look nobody has asked
  // for, and the five that are here are the ones a highlight is built from.
  const CENTRES = [
    null,
    { cx: 0.5, cy: 0, n: 'Top' },
    null,
    { cx: 0, cy: 0.5, n: 'Left' },
    { cx: 0.5, cy: 0.5, n: 'Centre' },
    { cx: 1, cy: 0.5, n: 'Right' },
    null,
    { cx: 0.5, cy: 1, n: 'Bottom' },
    null,
  ];
  function setCentre(c) {
    box.style.gradient.cx = c.cx;
    box.style.gradient.cy = c.cy;
    touch();
  }
  const near = (a, b) => Math.abs((a ?? 0) - b) < 0.02;

  // ---- gradient stops ----
  //
  // The stop bar: the ramp drawn left to right, a handle per stop under it, and
  // one row of controls for whichever handle is selected. It is a bar rather
  // than a list because a stop's whole meaning is WHERE it is, and a column of
  // percentages says that worse than a handle sitting at the place it means.
  //
  // The arrays here are `$state` proxies reached through `box.style`, so every
  // push/splice below mutates in place and the render follows; `touch()` is
  // what turns it into one undo entry.

  // Which handle the controls under the bar are talking about, by index. The
  // list is kept sorted, so an index is a stable enough name for it: the only
  // thing that reorders the list is a drag or a nudge, and both of those carry
  // the selection across the sort themselves.
  let stopIdx = $state(0);
  // The bar element, which is what a pointer position is measured against - the
  // handles sit on a rail of the same width below it. `$state` only because
  // `bind:this` writes it; nothing renders from either of these.
  let barEl = $state(null);
  // The <input type=color> behind the selected stop's swatch, so a double-click
  // on a handle can open the same picker the swatch opens.
  let stopSwatchEl = $state(null);
  // The index being dragged, or null. Not `$state`: nothing renders from it.
  let dragging = null;

  const gradStops = $derived(box?.style.gradient.stops ?? []);
  const selStop = $derived(gradStops[Math.min(stopIdx, gradStops.length - 1)] ?? null);
  // The bar shows the RAMP, not the gradient's direction: left to right whatever
  // the angle is, and flat whether the fill is linear or radial. The pad above
  // it is where direction is decided; asking the bar to say both at once would
  // leave a radial one as a bullseye you cannot read stop positions off.
  const barCss = $derived(gradientCss({ kind: 'linear', angle: 90, stops: gradStops }));

  // Selection belongs to the box, not to the panel: a different box's gradient
  // has different stops and the old index would name one of them.
  $effect(() => {
    box?.id;
    stopIdx = 0;
  });

  // Where along the bar a pointer is, 0..1.
  function posOf(e) {
    const r = barEl?.getBoundingClientRect();
    if (!r?.width) return 0;
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  }

  // Sorting reassigns the array from a plain snapshot rather than sorting the
  // proxy in place, so the selected stop can be found again afterwards by
  // identity - the proxies do not survive the swap, the plain objects they
  // snapshot to do. The sort is a real edit to the style - it changes which
  // colour the gradient starts at - so it has to touch() like every other
  // mutation, or a reorder that lands after the debounce has already fired is
  // never recorded and never marks the document unsaved.
  function sortStops(keep = stopIdx) {
    const raw = $state.snapshot(box.style.gradient.stops);
    const sel = raw[keep] ?? null;
    raw.sort((a, b) => a.pos - b.pos);
    box.style.gradient.stops = raw;
    if (sel) stopIdx = raw.indexOf(sel);
    touch();
  }

  // A click on an empty part of the bar adds a handle there, in the colour the
  // ramp was already showing at that spot - so the gesture gives the gradient a
  // control point without changing what it looks like.
  function addStopAt(p) {
    const stops = box.style.gradient.stops;
    if (stops.length >= GRADIENT_MAX_STOPS) return;
    const { color, opacity } = sampleStops($state.snapshot(stops), p);
    // Inserted in place rather than appended and sorted, so the list stays
    // ordered and the new stop's index is known without a search.
    let i = stops.findIndex((st) => st.pos > p);
    if (i < 0) i = stops.length;
    stops.splice(i, 0, { color, pos: p, opacity: Math.min(1, Math.max(0, opacity)) });
    stopIdx = i;
    touch();
  }
  function onBarDown(e) {
    // A handle is a button inside the same box and takes its own pointerdown;
    // anything else that lands here is the bar itself.
    if (e.target.closest('.gstop')) return;
    addStopAt(posOf(e));
  }

  // Midpoint of the widest quiet stretch of the ramp, rail ends included -
  // where a new stop has the most room to mean something. This is what the
  // add-stop button inserts at: the keyboard's answer to clicking an empty
  // part of the bar.
  function addStopWidestGap() {
    if (!box) return;
    const pts = box.style.gradient.stops
      .map((st) => clamp(Number(st.pos) || 0, 0, 1))
      .sort((a, b) => a - b);
    let gap = -1;
    let p = 0.5;
    const edges = [0, ...pts, 1];
    for (let i = 0; i < edges.length - 1; i++) {
      const w = edges[i + 1] - edges[i];
      if (w > gap) {
        gap = w;
        p = (edges[i] + edges[i + 1]) / 2;
      }
    }
    addStopAt(p);
  }

  function onStopDown(e, i) {
    // Selecting and dragging a handle is not clicking the bar under it.
    e.stopPropagation();
    e.preventDefault();
    stopIdx = i;
    dragging = i;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.focus();
  }
  // Live while the pointer moves, unsorted: a stop dragged past its neighbour
  // keeps its index until the pointer comes up, or the handle would swap out
  // from under the finger holding it. The ramp itself is correct either way -
  // both renderers read `pos`, not array order.
  function onStopMove(e) {
    if (dragging == null) return;
    const st = box.style.gradient.stops[dragging];
    if (!st) return;
    st.pos = posOf(e);
    touch();
  }
  function onStopUp(e) {
    if (dragging == null) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const was = dragging;
    dragging = null;
    sortStops(was);
  }
  // Arrow keys nudge the selected stop by a percent. The propagation stops here
  // because the canvas' own arrow keys nudge the whole BOX, and a handle with
  // focus is not an input the global shortcuts already stand back from.
  function onStopKey(e, i) {
    // Enter on a focused handle opens the colour picker, matching the
    // double-click - the one stop gesture pointer users had that keyboard
    // users did not.
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      openStopColour(e, i);
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const st = box.style.gradient.stops[i];
    if (!st) return;
    stopIdx = i;
    st.pos = clamp((Number(st.pos) || 0) + (e.key === 'ArrowRight' ? 0.01 : -0.01), 0, 1);
    sortStops(i);
  }
  // A double-click on a handle is the shortest way to the thing a stop is
  // mostly about, so it opens the colour picker the swatch below opens.
  function openStopColour(e, i) {
    e.stopPropagation();
    stopIdx = i;
    stopSwatchEl?.click();
  }

  function removeStop(i) {
    // Two stops is the floor: one stop is not a gradient, it is a fill.
    const stops = box.style.gradient.stops;
    if (stops.length <= 2) return;
    stops.splice(i, 1);
    if (stopIdx >= stops.length) stopIdx = stops.length - 1;
    touch();
  }

  // ---- patterns ----
  // A pattern is picked by looking at it. Each card draws the real tile through
  // the same painter the editor and the exporter use, in the box's own two
  // colours, so what is on the card is what lands on the glyphs.
  const PATTERN_LABELS = {
    dots: 'Dots',
    halftone: 'Halftone',
    stripes: 'Stripes',
    hstripes: 'Bands',
    diagonal: 'Diagonal',
    'diagonal-alt': 'Diagonal 2',
    crosshatch: 'Crosshatch',
    checker: 'Checker',
    grid: 'Grid',
    vlines: 'Hairline',
    hlines: 'Hairline 2',
  };
  const patLabel = (k) => PATTERN_LABELS[k] ?? k;
  // The card's tile is a fixed size rather than the box's, so the cards are
  // comparable with each other; `scale` is the slider under them.
  const CARD_SIZE = 44;
  const CARD_TILE = CARD_SIZE * 0.3;
  const patternCards = $derived.by(() => {
    const fg = box?.style.pattern.fg ?? '#000000';
    const bg = box?.style.pattern.bg ?? '#ffffff';
    const out = {};
    for (const k of PATTERN_KINDS) {
      const cnv = patternTileCanvas({ size: CARD_SIZE, pattern: { kind: k, fg, bg, scale: 1 } }, 2);
      out[k] = cnv ? cnv.toDataURL() : '';
    }
    return out;
  });
  function setPatternKind(k) {
    box.style.pattern.kind = k;
    touch();
  }

  // ---- strokes ----
  function addStroke() {
    const ks = box.style.strokes;
    // A new band goes OUTSIDE the ones already there (the array is innermost
    // first), which is the only place a second stroke is ever wanted.
    ks.push({ color: ks.length ? '#000000' : '#ffffff', width: 3, opacity: 1 });
    touch();
  }
  function removeStroke(i) {
    box.style.strokes.splice(i, 1);
    touch();
  }

  // ---- shadows ----
  function addShadow() {
    box.style.shadows.push({ x: 3, y: 3, blur: 4, color: '#000000', opacity: 0.5 });
    touch();
  }
  function removeShadow(i) {
    box.style.shadows.splice(i, 1);
    touch();
  }

  // ---- presets ----
  let presetId = $state('');

  // Save runs through an inline name field rather than window.prompt: the
  // native dialog blocks the page and looks like nothing else in the app.
  let naming = $state(false);
  let presetName = $state('');
  let presetNameEl = $state(null);
  // Delete is two-step: the first press arms it ('Sure?'), the second
  // confirms, and arming wears off on its own so a parked click cannot fire.
  let delArm = $state(false);
  let delArmT;

  // Reset selected preset dropdown when switching to a different box - which
  // also stands down any half-finished save or armed delete.
  $effect(() => {
    box?.id;
    presetId = '';
    naming = false;
    delArm = false;
    clearTimeout(delArmT);
  });
  // The name field takes focus as it appears, so typing a name starts at once.
  $effect(() => {
    if (naming && presetNameEl) presetNameEl.focus();
  });
  // A preset is a look, not a placement: the same three keys paste-style leaves
  // alone stay alone here too, or picking a preset silently un-rotates and
  // un-mirrors a box that was placed by hand.
  const PRESET_SKIP = ['rotation', 'flipH', 'flipV'];
  function applyPreset(id) {
    presetId = id;
    const p = presets.list.find((x) => x.id === id);
    if (!p) return;
    const next = cloneStyle(p.style);
    for (const k of PRESET_SKIP) delete next[k];
    Object.assign(box.style, next);
    touch();
  }
  function startSavePreset() {
    presetName = presets.list.find((p) => p.id === presetId)?.name ?? '';
    delArm = false;
    clearTimeout(delArmT);
    naming = true;
  }
  function cancelSavePreset() {
    naming = false;
  }
  function confirmSavePreset() {
    const name = presetName.trim();
    if (!name) return;
    const entry = savePreset(name, box.style);
    if (entry) presetId = entry.id;
    naming = false;
  }
  function onPresetNameKey(e) {
    if (e.key === 'Enter') confirmSavePreset();
    else if (e.key === 'Escape') cancelSavePreset();
  }
  function onDeletePreset() {
    if (!presetId) return;
    if (!delArm) {
      delArm = true;
      clearTimeout(delArmT);
      delArmT = setTimeout(() => (delArm = false), 2500);
      return;
    }
    clearTimeout(delArmT);
    delArm = false;
    removePreset(presetId);
    presetId = '';
  }

  // Deletion itself stays instant; the toast says how to take it back, which
  // is the feedback the silent undo record alone never gave a newcomer.
  function onDeleteBox() {
    const b = box;
    deleteBox(b.id);
    toast(
      isFreeBox(b)
        ? `Text box deleted · ${modKey()}Z to undo`
        : `Box deleted · line ${b.lineN} back to queue · ${modKey()}Z to undo`,
    );
  }

  const alignIcons = {
    left: ['M3 6h18', 'M3 12h12', 'M3 18h15'],
    center: ['M3 6h18', 'M6 12h12', 'M5 18h14'],
    right: ['M3 6h18', 'M9 12h12', 'M6 18h15'],
  };
  const valignIcons = {
    top: ['M4 6h16', 'M9 10h6v8h-6z'],
    middle: ['M4 12h16', 'M9 8h6v8h-6z'],
    bottom: ['M4 18h16', 'M9 6h6v8h-6z'],
  };
</script>

<!-- A heading inside a tab. Not a button any more - there is nothing left to
     collapse, because the tab already did the collapsing. -->
{#snippet secHead(title)}
  <div class="insp-sec">{title}</div>
{/snippet}

<!-- Swatch + hex, the one colour idiom in the panel. The label is named by
     the caller, as `swatchCell` does for the list rows - three identical
     "Colour" inputs are three identical names to a screen reader. -->
{#snippet colorField(obj, key, label = 'Colour')}
  <div class="color-field">
    <span class="swatch"><input type="color" bind:value={obj[key]} oninput={touch} aria-label={label} /></span>
    <input type="text" class="hex" value={obj[key]} aria-label="{label} hex" oninput={hexInput} onchange={(e) => setHex(obj, key, e.target.value, e.target)} />
  </div>
{/snippet}

<!-- The swatch on its own, for the compact list rows where the swatch and the
     hex field are two cells of the row's grid rather than a nested pair. -->
{#snippet swatchCell(obj, key, label)}
  <span class="swatch" title={label}><input type="color" bind:value={obj[key]} oninput={touch} aria-label={label} /></span>
{/snippet}

<!-- The one control that removes a list item. It closes every row, so the ×
     column is in the same place down the whole list. -->
{#snippet rmBtn(label, onRemove, canRemove = true)}
  <button type="button" class="icon-btn" title="Remove {label}" aria-label="Remove {label}" disabled={!canRemove} onclick={onRemove}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
  </button>
{/snippet}

{#snippet addBtn(label, onAdd)}
  <button type="button" class="add-btn" onclick={onAdd}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
    {label}
  </button>
{/snippet}

<!-- The brush takes the whole body, ahead of the selection check: while the tool
     is armed the panel is the tool's options, and a letterer who has not clicked
     a box yet still needs the size slider. `.insp` is the frame the shared
     controls are laid out inside, so the panel keeps it. -->
{#if brushArmed()}
  <div class="insp"><BrushPanel /></div>
{:else if !box}
  <div class="insp-empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" /><path d="M12 4v16" /><path d="M9 20h6" /></svg>
    <div>No text box selected.<br />Click a box, or use the Text tool to add one.</div>
  </div>
{:else}
  {@const s = box.style}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- Capture phase, so the snapshot lands before any control's own handler
       mutates the style - see armSnap. -->
  <div class="insp" onpointerdowncapture={armSnap} onkeydowncapture={armSnap}>
    <div class="insp-tabs" role="tablist" aria-label="Text box options">
      {#each TABS as [id, label] (id)}
        <button
          type="button"
          role="tab"
          id="insp-tab-{id}"
          class="insp-tab"
          class:on={tab === id}
          aria-selected={tab === id}
          aria-controls="insp-pane-{id}"
          tabindex={tab === id ? 0 : -1}
          title={label}
          onclick={() => setTab(id)}
          onkeydown={(e) => onTabKey(e, id)}
        >
          {@html tabIcons[id]}
          <span>{label}</span>
        </button>
      {/each}
    </div>

    <!-- ===== Text ===== -->
    {#if tab === 'text'}
      <div class="insp-pane" role="tabpanel" id="insp-pane-text" aria-labelledby="insp-tab-text">
        <div class="grp">
          <label class="lbl" for="insp-text">Content {isFreeBox(box) ? '· free' : `· line ${box.lineN}`}</label>
          <textarea id="insp-text" value={boxText(box)} oninput={onTextInput} onkeydown={onTextKey} ondblclick={() => beginEdit(box.id)}></textarea>
        </div>
        <div class="grp">
          <label class="lbl" for="insp-font">Font</label>
          <!-- Each option carries its own family, so the menu is the specimen
               sheet: you pick a lettering face by looking at it. -->
          <select id="insp-font" bind:value={s.font} onchange={touch} style="font-family:{fontCssFor(s.font)}">
            {#if s.font && !isFontOffered(s.font)}
              <!-- The box is set in a family the menus no longer offer - hidden,
                   or from a machine that had it. The select still has to say so. -->
              <option value={s.font} style="font-family:{fontCssFor(s.font)}">{s.font} (not in menus)</option>
            {/if}
            {#each fontGroups() as g (g.key)}
              <optgroup label={g.label}>
                {#each g.fonts as f (f.name)}<option value={f.name} style="font-family:{f.css}">{f.name}</option>{/each}
              </optgroup>
            {/each}
          </select>
        </div>
        <!-- Size and the weight it is set in, side by side: they are one
             decision about the face, and they were three rows apart. -->
        <div class="row-size">
          <div class="field">
            <label class="lbl" for="insp-size">Size</label>
            <select id="insp-size" value={String(sizeNow)} onchange={(e) => setSize(e.target.value)}>
              {#each sizeList as n (n)}<option value={String(n)}>{n} px</option>{/each}
            </select>
          </div>
          <div class="field">
            <span class="lbl">Style</span>
            <div class="seg">
              <button type="button" class:on={s.bold} aria-pressed={s.bold} title="Bold" onclick={() => { s.bold = !s.bold; touch(); }}><b>B</b></button>
              <button type="button" class:on={s.italic} aria-pressed={s.italic} title="Italic" onclick={() => { s.italic = !s.italic; touch(); }}><i>I</i></button>
              <button type="button" class:on={s.uppercase} aria-pressed={s.uppercase} title="Uppercase" onclick={() => { s.uppercase = !s.uppercase; touch(); }}>TT</button>
            </div>
          </div>
        </div>

        <div class="insp-rule"></div>

        <!-- The exact angle is typed, not read off the header, so the row keeps
             only the two quarter-turns and the reset. ±15 went: six buttons and
             a slider do not fit a 280px panel, and the number field does that
             job better than a button that only steps one way. -->
        <div class="grp">
          <span class="lbl ico">{@html iconRotate} Rotation</span>
          <div class="rot-row">
            <button type="button" class="rbtn" title="Rotate −90°" onclick={() => rotateBy(-90)}>−90</button>
            <input type="range" min="-180" max="180" step="1" value={s.rotation} aria-label="Rotation" oninput={(e) => setRotation(e.target.value)} />
            <button type="button" class="rbtn" title="Rotate +90°" onclick={() => rotateBy(90)}>+90</button>
            <input class="deg" type="number" min="-180" max="180" step="1" value={Math.round(s.rotation)} aria-label="Rotation, degrees" title="Rotation in degrees" onchange={(e) => commitNum(s, 'rotation', e, -180, 180, true)} />
            <button type="button" class="rbtn reset" title="Reset to 0°" onclick={() => setRotation(0)} disabled={Math.round(s.rotation) === 0}>0°</button>
          </div>
        </div>
      </div>
    {/if}

    <!-- ===== Fill ===== -->
    {#if tab === 'fill'}
      <div class="insp-pane" role="tabpanel" id="insp-pane-fill" aria-labelledby="insp-tab-fill">
        <div class="grp">
          <span class="lbl">Fill</span>
          <div class="seg">
            {#each [['solid', 'Solid'], ['gradient', 'Gradient'], ['pattern', 'Pattern']] as [m, label] (m)}
              <button type="button" class:on={fillMode === m} aria-pressed={fillMode === m} onclick={() => setFillMode(m)}>{label}</button>
            {/each}
          </div>
        </div>

        {#if fillMode === 'solid'}
          <div class="grp">
            <span class="lbl">Colour</span>
            {@render colorField(s, 'color', 'Fill colour')}
          </div>
        {:else if fillMode === 'gradient'}
          <!-- The gradient, top to bottom in the order it is built: what shape
               it is, where it runs, where it stops, and what it looks like
               while you do it. -->
          <div class="seg">
            <button type="button" class="kbtn" class:on={s.gradient.kind !== 'radial'} aria-pressed={s.gradient.kind !== 'radial'} title="Linear gradient" onclick={() => setGradKind('linear')}>
              {@html iconGradientLinear}<span>Linear</span>
            </button>
            <button type="button" class="kbtn" class:on={s.gradient.kind === 'radial'} aria-pressed={s.gradient.kind === 'radial'} title="Radial gradient" onclick={() => setGradKind('radial')}>
              {@html iconGradientRadial}<span>Radial</span>
            </button>
          </div>

          <!-- The stop bar. The ramp, the handles that set it, and the one
               handle that is selected - and clicking anywhere on the bar that
               is not a handle puts a new one there. -->
          <div class="grad-edit" role="presentation" onpointerdown={onBarDown}>
            <div class="grad-bar">
              <!-- The ramp, not the bar around it, is what a pointer position is
                   measured against: it is the box the rail's handles are laid
                   out in, so the two are the same ruler down to the pixel. -->
              <div class="grad-ramp" bind:this={barEl} style="background-image:{barCss}"></div>
            </div>
            <div class="grad-rail">
              {#each s.gradient.stops as st, i (i)}
                <button
                  type="button"
                  class="gstop"
                  class:on={i === stopIdx}
                  style="left:{clamp(Number(st.pos) || 0, 0, 1) * 100}%;--stop-c:{st.color}"
                  title="Stop {i + 1} · {pct(st.pos)}% · drag to move, double-click or press Enter for colour"
                  aria-label="Stop {i + 1} at {pct(st.pos)} percent"
                  aria-pressed={i === stopIdx}
                  onpointerdown={(e) => onStopDown(e, i)}
                  onpointermove={onStopMove}
                  onpointerup={onStopUp}
                  onpointercancel={onStopUp}
                  ondblclick={(e) => openStopColour(e, i)}
                  onkeydown={(e) => onStopKey(e, i)}
                ></button>
              {/each}
            </div>
          </div>

          <!-- One stop's own fields. The list used to be here in full; a stop
               that is not selected has nothing to say that its handle is not
               already saying by sitting where it sits. -->
          {#if selStop}
            <!-- The caption sits above its fields, as it does in the Effects
                 lists; the columns are shared with the row below it. -->
            <div class="insp-cap grad-cap"><span></span><span></span><span class="left">Colour</span><span>Pos %</span><span>Op %</span><span></span><span></span></div>
            <div class="grad-sel">
              <span class="grad-n">{Math.min(stopIdx, s.gradient.stops.length - 1) + 1}/{s.gradient.stops.length}</span>
              <!-- The swatch snippet's own markup, spelled out here because this
                   one needs a handle on the input: a double-click on a stop
                   opens this picker. -->
              <span class="swatch" title="Stop colour">
                <input type="color" bind:this={stopSwatchEl} bind:value={selStop.color} oninput={touch} aria-label="Stop colour" />
              </span>
              <input type="text" class="hex" value={selStop.color} aria-label="Stop hex colour" oninput={hexInput} onchange={(e) => setHex(selStop, 'color', e.target.value, e.target)} />
              <input type="number" min="0" max="100" step="1" value={pct(selStop.pos)} aria-label="Stop position" title="Position along the gradient, %" oninput={(e) => setAlpha(selStop, 'pos', e.target.value)} onchange={() => sortStops()} />
              <input type="number" min="0" max="100" step="1" value={pct(selStop.opacity)} aria-label="Stop opacity" title="Opacity of this stop, %" oninput={(e) => setAlpha(selStop, 'opacity', e.target.value)} />
              <!-- The keyboard's add-a-stop, for whoever never found
                   click-the-empty-bar. It lands in the widest gap. -->
              <button
                type="button"
                class="icon-btn"
                title={s.gradient.stops.length >= GRADIENT_MAX_STOPS ? `At most ${GRADIENT_MAX_STOPS} stops` : 'Add a stop in the widest gap'}
                aria-label="Add gradient stop"
                disabled={s.gradient.stops.length >= GRADIENT_MAX_STOPS}
                onclick={addStopWidestGap}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
              </button>
              <button
                type="button"
                class="icon-btn"
                title={s.gradient.stops.length > 2 ? 'Delete this stop' : 'A gradient needs two stops'}
                aria-label="Delete stop"
                disabled={s.gradient.stops.length <= 2}
                onclick={() => removeStop(Math.min(stopIdx, s.gradient.stops.length - 1))}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13" /></svg>
              </button>
            </div>
          {/if}

          {#if s.gradient.kind === 'radial'}
            <!-- A style that reached the panel without going through
                 `normalizeStyle` (an old undo snapshot, a hand-edited file) has
                 no radius at all, and an empty number field is a worse answer
                 than the default the renderers would use for it anyway. -->
            {@const rad = Number.isFinite(+s.gradient.radius) ? +s.gradient.radius : 1}
            <div class="pad-row">
              <div class="dirpad" role="radiogroup" aria-label="Gradient centre">
                {#each CENTRES as c, i (i)}
                  {#if c}
                    <button
                      type="button"
                      role="radio"
                      class="cell"
                      class:on={near(s.gradient.cx, c.cx) && near(s.gradient.cy, c.cy)}
                      title={c.n}
                      aria-label="Centre {c.n.toLowerCase()}"
                      aria-checked={near(s.gradient.cx, c.cx) && near(s.gradient.cy, c.cy)}
                      onclick={() => setCentre(c)}
                    ><span class="cdot"></span></button>
                  {:else}
                    <span class="cell blank"></span>
                  {/if}
                {/each}
              </div>
              <div class="pad-side">
                <div class="field">
                  <label class="lbl" for="insp-grad-radius">Radius · {Math.round(rad * 100)}%</label>
                  <div class="slider-row">
                    <input id="insp-grad-radius" type="range" min="0.1" max="4" step="0.05" value={rad} aria-label="Radius" oninput={(e) => setNum(s.gradient, 'radius', e.target.value, 0.1, 4)} />
                  </div>
                  <input type="number" min="0.1" max="4" step="0.05" value={rad} title="How far the last stop is from the centre, as a multiple of the distance to the far corner" aria-label="Radius, multiple" oninput={(e) => setNum(s.gradient, 'radius', e.target.value, 0.1, 4)} />
                </div>
              </div>
            </div>
          {:else}
            <div class="pad-row">
              <div class="dirpad" role="radiogroup" aria-label="Gradient direction">
                {#each DIRS as d, i (i)}
                  {#if d}
                    <button
                      type="button"
                      role="radio"
                      class="cell"
                      class:on={Math.round(s.gradient.angle) % 360 === d.a}
                      title="{d.n} · {d.a}°"
                      aria-label="{d.n}, {d.a} degrees"
                      aria-checked={Math.round(s.gradient.angle) % 360 === d.a}
                      onclick={() => setAngle(d.a)}
                    ><span class="arrow" style="transform:rotate({d.a}deg)">{@html iconArrowUp}</span></button>
                  {:else}
                    <span class="cell mid">{Math.round(s.gradient.angle)}°</span>
                  {/if}
                {/each}
              </div>
              <div class="pad-side">
                <div class="field">
                  <label class="lbl" for="insp-grad-angle">Angle</label>
                  <input id="insp-grad-angle" type="number" min="0" max="360" step="5" value={Math.round(s.gradient.angle)} title="0° runs bottom to top, 90° left to right" oninput={(e) => setNum(s.gradient, 'angle', e.target.value, 0, 360, true)} />
                </div>
              </div>
            </div>
          {/if}

          <div class="grp">
            <span class="lbl">Spans</span>
            <div class="seg">
              <button type="button" class:on={s.gradient.scope === 'box'} aria-pressed={s.gradient.scope === 'box'} title="One gradient across the whole block" onclick={() => { s.gradient.scope = 'box'; touch(); }}>Box</button>
              <button type="button" class:on={s.gradient.scope === 'line'} aria-pressed={s.gradient.scope === 'line'} title="Restart the gradient on every line" onclick={() => { s.gradient.scope = 'line'; touch(); }}>Line</button>
            </div>
          </div>

        {:else}
          <div class="grp">
            <span class="lbl">Tile</span>
            <div class="pat-grid" role="radiogroup" aria-label="Pattern">
              {#each PATTERN_KINDS as k (k)}
                <button
                  type="button"
                  role="radio"
                  aria-checked={s.pattern.kind === k}
                  class="pat-card"
                  class:on={s.pattern.kind === k}
                  title={patLabel(k)}
                  onclick={() => setPatternKind(k)}
                >
                  <span class="pat-tile" style="background-image:url({patternCards[k]});background-size:{CARD_TILE}px {CARD_TILE}px"></span>
                  <span class="pat-name">{patLabel(k)}</span>
                </button>
              {/each}
            </div>
          </div>
          <div class="grp">
            <span class="lbl">Scale · {Number(s.pattern.scale).toFixed(2)}×</span>
            <!-- 0.25..4 is what normalizeStyle clamps to; a wider field here
                 just let the panel show a number the model would not keep. -->
            <div class="slider-row">
              <input type="range" min="0.25" max="4" step="0.05" value={s.pattern.scale} aria-label="Pattern scale" oninput={(e) => setNum(s.pattern, 'scale', e.target.value, 0.25, 4)} />
              <input class="num-s" type="number" min="0.25" max="4" step="0.05" value={s.pattern.scale} title="Tile size, relative to the font size" aria-label="Pattern scale, multiple" oninput={(e) => setNum(s.pattern, 'scale', e.target.value, 0.25, 4)} />
            </div>
          </div>
          <div class="row2">
            <div class="field">
              <span class="lbl">Pattern</span>
              {@render colorField(s.pattern, 'fg', 'Pattern colour')}
            </div>
            <div class="field">
              <span class="lbl">Background</span>
              {@render colorField(s.pattern, 'bg', 'Background colour')}
            </div>
          </div>
        {/if}

        <div class="insp-rule"></div>

        <div class="grp">
          <span class="lbl">Opacity</span>
          <div class="slider-row">
            <input type="range" min="0" max="100" step="1" value={pct(s.opacity)} aria-label="Opacity" oninput={(e) => setAlpha(s, 'opacity', e.target.value)} />
            <input class="num-s" type="number" min="0" max="100" step="1" value={pct(s.opacity)} title="Opacity, %" aria-label="Opacity, percent" onchange={(e) => commitAlpha(s, 'opacity', e)} />
          </div>
        </div>
      </div>
    {/if}

    <!-- ===== Effects ===== -->
    {#if tab === 'effects'}
      <div class="insp-pane" role="tabpanel" id="insp-pane-effects" aria-labelledby="insp-tab-effects">
        <div class="sub-tabs" role="tablist" aria-label="Effects options">
          {#each EFFECTS_TABS as [id, label] (id)}
            <button
              type="button"
              role="tab"
              id="insp-subtab-{id}"
              class="sub-tab"
              class:on={effectsSubTab.id === id}
              aria-selected={effectsSubTab.id === id}
              aria-label={label}
              tabindex={effectsSubTab.id === id ? 0 : -1}
              title={label}
              onclick={() => setEffectsSubTab(id)}
              onkeydown={(e) => onSubTabKey(e, id)}
            >
              {@html effectsSubTabIcons[id]}
            </button>
          {/each}
        </div>

        {#if effectsSubTab.id === 'stroke'}
          <!-- Strokes: innermost first, which is also the order they are listed. -->
          {@render secHead('Strokes · inner to outer')}
          <div class="grp">
            {#if !s.strokes.length}
              <div class="insp-none">No stroke.</div>
            {/if}
            <div class="insp-list k-stroke">
              {#if s.strokes.length}
                <div class="insp-cap"><span></span><span class="left">Colour</span><span>Width</span><span>Op %</span><span></span></div>
              {/if}
              {#each s.strokes as k, i (k)}
                <div class="insp-row">
                  {@render swatchCell(k, 'color', `Stroke ${i + 1} colour`)}
                  <input type="text" class="hex" value={k.color} aria-label="Stroke {i + 1} hex colour" oninput={hexInput} onchange={(e) => setHex(k, 'color', e.target.value, e.target)} />
                  <input type="number" min="0.5" max="40" step="0.5" value={k.width} aria-label="Stroke {i + 1} width" title="Visible band width, page px" oninput={(e) => setNum(k, 'width', e.target.value, 0.5, 40)} />
                  <input type="number" min="0" max="100" step="1" value={pct(k.opacity)} aria-label="Stroke {i + 1} opacity" title="Opacity, %" oninput={(e) => setAlpha(k, 'opacity', e.target.value)} />
                  {@render rmBtn(`stroke ${i + 1}`, () => removeStroke(i))}
                </div>
              {/each}
            </div>
            {@render addBtn('Add stroke', addStroke)}
          </div>
        {/if}

        {#if effectsSubTab.id === 'shadow'}
          <!-- Shadows: the first one is painted on top of the rest. -->
          {@render secHead('Shadows · first on top')}
          <div class="grp">
            {#if !s.shadows.length}
              <div class="insp-none">No shadow.</div>
            {/if}
            <div class="insp-list k-shadow">
              {#if s.shadows.length}
                <div class="insp-cap"><span></span><span>X</span><span>Y</span><span>Blur</span><span>Op %</span><span></span></div>
              {/if}
              {#each s.shadows as sh, i (sh)}
                <div class="insp-row">
                  {@render swatchCell(sh, 'color', `Shadow ${i + 1} colour`)}
                  <input type="number" min="-200" max="200" step="1" value={sh.x} aria-label="Shadow {i + 1} offset X" title="Offset X, page px" onchange={(e) => commitNum(sh, 'x', e, -200, 200)} />
                  <input type="number" min="-200" max="200" step="1" value={sh.y} aria-label="Shadow {i + 1} offset Y" title="Offset Y, page px" onchange={(e) => commitNum(sh, 'y', e, -200, 200)} />
                  <input type="number" min="0" max="50" step="1" value={sh.blur} aria-label="Shadow {i + 1} blur" title="Blur, page px" oninput={(e) => setNum(sh, 'blur', e.target.value, 0, 50)} />
                  <input type="number" min="0" max="100" step="1" value={pct(sh.opacity)} aria-label="Shadow {i + 1} opacity" title="Opacity, %" oninput={(e) => setAlpha(sh, 'opacity', e.target.value)} />
                  {@render rmBtn(`shadow ${i + 1}`, () => removeShadow(i))}
                </div>
              {/each}
            </div>
            {@render addBtn('Add shadow', addShadow)}
          </div>
        {/if}

        {#if effectsSubTab.id === 'warp'}
          <div class="grp">
            <span class="lbl" title="Bend the baseline upward/downward">Arc</span>
            <div class="slider-row">
              <input type="range" min="-100" max="100" step="1" value={s.curve} disabled={s.path.on || s.circle.on} title={s.path.on || s.circle.on ? 'Curve path or Circle is on; they override Arc' : undefined} aria-label="Arc" oninput={(e) => setNum(s, 'curve', e.target.value, -100, 100)} />
              <input class="num-s" type="number" min="-100" max="100" step="1" value={s.curve} disabled={s.path.on || s.circle.on} title={s.path.on || s.circle.on ? 'Curve path or Circle is on; they override Arc' : 'Bend the baseline upward/downward'} aria-label="Arc, amount" onchange={(e) => commitNum(s, 'curve', e, -100, 100)} />
            </div>
          </div>
          <div class="insp-rule"></div>
          <div class="switch-row">
            <button
              type="button"
              class="switch"
              class:on={s.circle.on}
              role="switch"
              aria-checked={s.circle.on}
              aria-label="Circle"
              onclick={() => {
                s.circle.on = !s.circle.on;
                if (s.circle.on) s.path.on = false;
                touch();
              }}
            ><span class="knob"></span></button>
            <span class="lbl2">Circle</span>
          </div>
          <div class="insp-sub-body" class:disabled={!s.circle.on} style="padding:0;border:none;gap:11px">
            <div class="grp">
              <span class="lbl">Angle</span>
              <div class="slider-row">
                <input type="range" min="0" max="359" step="1" value={s.circle.angle} disabled={!s.circle.on} title="Turns the ring, degrees" aria-label="Angle" oninput={(e) => setNum(s.circle, 'angle', e.target.value, 0, 359)} />
                <input class="num-s" type="number" min="0" max="359" step="1" value={s.circle.angle} disabled={!s.circle.on} title="Turns the ring, degrees" aria-label="Angle, degrees" onchange={(e) => commitNum(s.circle, 'angle', e, 0, 359)} />
              </div>
            </div>
            <div class="grp">
              <span class="lbl">Radius</span>
              <div class="slider-row">
                <input type="range" min="0" max="600" step="1" value={Math.min(600, s.circle.r)} disabled={!s.circle.on} title="Ring radius in px. 0 fits the ring to the text; any other value holds the size and the text runs as far round as it reaches." aria-label="Radius" oninput={(e) => setNum(s.circle, 'r', e.target.value, 0, 4000)} />
                <input class="num-s" type="number" min="0" max="4000" step="1" value={s.circle.r} disabled={!s.circle.on} title="0 = auto (fit the ring to the text)" aria-label="Radius, px" onchange={(e) => commitNum(s.circle, 'r', e, 0, 4000)} />
              </div>
            </div>
            <div class="switch-row">
              <button
                type="button"
                class="switch"
                class:on={s.circle.inside}
                role="switch"
                aria-checked={s.circle.inside}
                aria-label="Inside (badge bottom)"
                onclick={() => {
                  if (!s.circle.on) return;
                  s.circle.inside = !s.circle.inside;
                  touch();
                }}
              ><span class="knob"></span></button>
              <span class="lbl2">Inside (badge bottom)</span>
            </div>
          </div>
          <div class="insp-rule"></div>
          <div class="switch-row">
            <button
              type="button"
              class="switch"
              class:on={s.path.on}
              role="switch"
              aria-checked={s.path.on}
              aria-label="Curve path"
              onclick={() => {
                s.path.on = !s.path.on;
                if (s.path.on) s.circle.on = false;
                if (s.path.on && s.path.pts.length < 2) s.path.pts = defaultPathPts(box.w, box.h);
                touch();
              }}
            ><span class="knob"></span></button>
            <span class="lbl2">Curve path</span>
          </div>
          {#if s.path.on}
            <div class="insp-none">Drag the red anchors and square handles on the box. Right-click an anchor to remove it.</div>
            {@render addBtn('Add anchor', () => { s.path.pts = insertPathAnchor(s.path.pts); touch(); })}
            {@render addBtn('Reset path', () => { s.path.pts = defaultPathPts(box.w, box.h); touch(); })}
          {/if}
        {/if}

        {#if effectsSubTab.id === 'transform'}
          <!-- The mesh. One setting at two grid sizes, exactly as CSP has it:
               Free is the four corner handles and a perspective map, Mesh is a
               grid the picture bends smoothly through. The handles are ON THE
               BOX, not in here - this panel only arms the gizmo, picks the
               mode, sizes the grid and resets it. -->
          {@const free = warpIsFree(s)}
          <div class="switch-row">
            <button
              type="button"
              class="switch"
              class:on={s.warp.on}
              role="switch"
              aria-checked={s.warp.on}
              aria-label="Transform"
              onclick={() => { s.warp.on = !s.warp.on; touch(); }}
            ><span class="knob"></span></button>
            <span class="lbl2">Transform</span>
          </div>
          <div class="insp-sub-body" class:disabled={!s.warp.on} style="padding:0;border:none;gap:11px">
            <div class="grp">
              <span class="lbl">Handles</span>
              <div class="seg">
                <button
                  type="button"
                  class:on={free}
                  aria-pressed={free}
                  disabled={!s.warp.on}
                  title="Four corners. Pull one and the box goes into perspective."
                  onclick={() => setWarpMode(s, true)}
                >Free</button>
                <button
                  type="button"
                  class:on={!free}
                  aria-pressed={!free}
                  disabled={!s.warp.on}
                  title="A grid of dots. The picture bends smoothly between them."
                  onclick={() => setWarpMode(s, false)}
                >Mesh</button>
              </div>
            </div>
            {#if !free}
              <div class="row2">
                <div class="field">
                  <label class="lbl" for="insp-warp-cols">Columns</label>
                  <input
                    id="insp-warp-cols"
                    type="number"
                    min={WARP_MIN_GRID}
                    max={WARP_MAX_GRID}
                    step="1"
                    value={s.warp.cols}
                    disabled={!s.warp.on}
                    title="Grid cells across."
                    onchange={(e) => setGrid(s, 'cols', e)}
                  />
                </div>
                <div class="field">
                  <label class="lbl" for="insp-warp-rows">Rows</label>
                  <input
                    id="insp-warp-rows"
                    type="number"
                    min={WARP_MIN_GRID}
                    max={WARP_MAX_GRID}
                    step="1"
                    value={s.warp.rows}
                    disabled={!s.warp.on}
                    title="Grid cells down."
                    onchange={(e) => setGrid(s, 'rows', e)}
                  />
                </div>
              </div>
            {/if}
            <!-- Says what the gizmo is for, and warns about the one thing a
                 grid change cannot promise: the deformation is carried onto the
                 new grid, but a finer mesh rebuilt onto a coarser one keeps only
                 what the coarser one can say. -->
            <div class="insp-none">
              {#if free}
                Drag a corner on the box; the picture goes into perspective. The
                dashed outline is where the box started; Esc during a drag puts
                it back.
              {:else}
                Drag the dots on the box; the picture bends smoothly between
                them. The dashed outline is where the box started; Esc during a
                drag puts it back. Changing the grid carries the deformation
                over, and a smaller grid keeps only what its dots can say.
              {/if}
            </div>
            <div class="mask-row">
              <span class="mask-count">{s.warp.pts.length ? `${s.warp.cols} x ${s.warp.rows} mesh` : 'Not deformed'}</span>
              <button
                type="button"
                class="rbtn"
                disabled={!s.warp.pts.length}
                onclick={() => {
                  if (!s.warp.pts.length) return;
                  s.warp.pts = [];
                  touch();
                }}
              >Reset mesh</button>
            </div>
          </div>
        {/if}

        {#if effectsSubTab.id === 'liquify'}
          <!-- Liquify: the tool that pushes the box's mesh around under the
               pointer. The controls are the tool's, not the box's - session
               state, like the mask tools - and what a drag writes is the same
               `warp` the Transform sub-tab edits, so Reset is shared. -->
          {@const LIQ_LABEL = { push: 'Push', expand: 'Expand', pinch: 'Pinch', twirl: 'Twirl' }}
          {@const LIQ_HINT = {
            push: 'Drags the box along with the pointer.',
            expand: 'Pushes outwards from the circle’s centre.',
            pinch: 'Pulls inwards towards the circle’s centre.',
            twirl: 'Turns about the circle’s centre.',
          }}
          <div class="grp">
            <span class="lbl">Tool</span>
            <div class="seg">
              {#each LIQUIFY_MODES as m (m)}
                <button type="button" class:on={liquifyTool.mode === m} aria-pressed={liquifyTool.mode === m} title={LIQ_HINT[m]} onclick={() => setLiquifyMode(m)}>{LIQ_LABEL[m]}</button>
              {/each}
            </div>
          </div>
          <div class="grp">
            <span class="lbl">Radius</span>
            <div class="slider-row">
              <input type="range" min={LIQUIFY_RADIUS_MIN} max={LIQUIFY_RADIUS_MAX} step="1" value={liquifyTool.radius} title="How far the tool reaches, in page px" aria-label="Liquify radius" oninput={(e) => (liquifyTool.radius = clamp(Number(e.target.value) || 0, LIQUIFY_RADIUS_MIN, LIQUIFY_RADIUS_MAX))} />
              <input class="num-s" type="number" min={LIQUIFY_RADIUS_MIN} max={LIQUIFY_RADIUS_MAX} step="1" value={liquifyTool.radius} aria-label="Liquify radius, page px" onchange={(e) => (liquifyTool.radius = clamp(Number(e.target.value) || 0, LIQUIFY_RADIUS_MIN, LIQUIFY_RADIUS_MAX))} />
            </div>
          </div>
          <div class="grp">
            <span class="lbl">Strength</span>
            <div class="slider-row">
              <input type="range" min="0" max="100" step="1" value={liquifyTool.strength} title="How far the picture moves at the centre of the circle" aria-label="Liquify strength" oninput={(e) => (liquifyTool.strength = clamp(Number(e.target.value) || 0, 0, 100))} />
              <input class="num-s" type="number" min="0" max="100" step="1" value={liquifyTool.strength} aria-label="Liquify strength, percent" onchange={(e) => (liquifyTool.strength = clamp(Number(e.target.value) || 0, 0, 100))} />
            </div>
          </div>
          <div class="insp-none">
            {LIQ_HINT[liquifyTool.mode] ?? ''} Drag on the box; the circle is what the tool reaches. It bends the text and the ink together, through the box's mesh. Esc during a drag puts it back.
          </div>
          <div class="mask-row">
            <span class="mask-count">{s.warp.pts.length ? `${s.warp.cols} x ${s.warp.rows} mesh` : 'Not deformed'}</span>
            <button
              type="button"
              class="rbtn"
              disabled={!s.warp.pts.length}
              onclick={() => {
                if (!s.warp.pts.length) return;
                s.warp.pts = [];
                touch();
              }}
            >Reset mesh</button>
          </div>
        {/if}

        {#if effectsSubTab.id === 'blur'}
          <div class="grp">
            <span class="lbl">Blur</span>
            <div class="slider-row">
              <input type="range" min="0" max="20" step="0.5" value={s.blur} aria-label="Blur" oninput={(e) => setNum(s, 'blur', e.target.value, 0, 20)} />
              <input class="num-s" type="number" min="0" max="20" step="0.5" value={s.blur} title="Blur, page px" aria-label="Blur, page px" onchange={(e) => commitNum(s, 'blur', e, 0, 20)} />
            </div>
          </div>
          <div class="insp-rule"></div>
          <div class="switch-row">
            <button
              type="button"
              class="switch"
              class:on={s.motionBlur.on}
              role="switch"
              aria-checked={s.motionBlur.on}
              aria-label="Motion blur"
              onclick={() => { s.motionBlur.on = !s.motionBlur.on; touch(); }}
            ><span class="knob"></span></button>
            <span class="lbl2">Motion blur</span>
          </div>
          <div class="insp-sub-body" class:disabled={!s.motionBlur.on} style="padding:0;border:none;gap:11px">
            <div class="grp">
              <span class="lbl">X</span>
              <div class="slider-row">
                <input type="range" min="-10" max="10" step="0.1" value={s.motionBlur.x} disabled={!s.motionBlur.on} aria-label="X" oninput={(e) => setNum(s.motionBlur, 'x', e.target.value, -10, 10)} />
                <input class="num-s" type="number" min="-10" max="10" step="0.1" value={s.motionBlur.x} disabled={!s.motionBlur.on} title="Smear direction X, pixels per step" aria-label="X" onchange={(e) => commitNum(s.motionBlur, 'x', e, -10, 10)} />
              </div>
            </div>
            <div class="grp">
              <span class="lbl">Y</span>
              <div class="slider-row">
                <input type="range" min="-10" max="10" step="0.1" value={s.motionBlur.y} disabled={!s.motionBlur.on} aria-label="Y" oninput={(e) => setNum(s.motionBlur, 'y', e.target.value, -10, 10)} />
                <input class="num-s" type="number" min="-10" max="10" step="0.1" value={s.motionBlur.y} disabled={!s.motionBlur.on} title="Smear direction Y, pixels per step" aria-label="Y" onchange={(e) => commitNum(s.motionBlur, 'y', e, -10, 10)} />
              </div>
            </div>
            <div class="grp">
              <span class="lbl">Amount</span>
              <div class="slider-row">
                <input type="range" min="1" max="32" step="1" value={s.motionBlur.amount} disabled={!s.motionBlur.on} aria-label="Amount" oninput={(e) => setNum(s.motionBlur, 'amount', e.target.value, 1, 32, true)} />
                <input class="num-s" type="number" min="1" max="32" step="1" value={s.motionBlur.amount} disabled={!s.motionBlur.on} title="Blur iterations - more is smoother and longer" aria-label="Amount" onchange={(e) => commitNum(s.motionBlur, 'amount', e, 1, 32, true)} />
              </div>
            </div>
          </div>
        {/if}

        {#if effectsSubTab.id === 'edges'}
          <div class="switch-row">
            <button type="button" class="switch" class:on={s.roughen.on} role="switch" aria-checked={s.roughen.on} aria-label="Roughen edges" onclick={() => { s.roughen.on = !s.roughen.on; touch(); }}><span class="knob"></span></button>
            <span class="lbl2">Roughen edges</span>
          </div>
          <div class="insp-sub-body" class:disabled={!s.roughen.on} style="padding:0;border:none;gap:11px">
            <div class="grp">
              <span class="lbl">Amount</span>
              <div class="slider-row"><input type="range" min="0" max="20" step="0.5" value={s.roughen.amount} disabled={!s.roughen.on} aria-label="Roughen amount" oninput={(e) => setNum(s.roughen, 'amount', e.target.value, 0, 20)} /><input class="num-s" type="number" min="0" max="20" step="0.5" value={s.roughen.amount} disabled={!s.roughen.on} title="Distortion strength" aria-label="Roughen amount" onchange={(e) => commitNum(s.roughen, 'amount', e, 0, 20)} /></div>
            </div>
            <div class="grp">
              <span class="lbl">Grain</span>
              <div class="slider-row"><input type="range" min="0.01" max="0.2" step="0.005" value={s.roughen.detail} disabled={!s.roughen.on} aria-label="Roughen grain" oninput={(e) => setNum(s.roughen, 'detail', e.target.value, 0.01, 0.2)} /><input class="num-s" type="number" min="0.01" max="0.2" step="0.005" value={s.roughen.detail} disabled={!s.roughen.on} title="Grain density, 0.01–0.2" aria-label="Roughen grain" onchange={(e) => commitNum(s.roughen, 'detail', e, 0.01, 0.2)} /></div>
            </div>
            <div class="grp">
              <label class="lbl" for="insp-seed">Seed</label>
              <input id="insp-seed" type="number" min="0" max="999" value={s.roughen.seed} disabled={!s.roughen.on} title="Varies the distortion pattern; same seed = same result" oninput={(e) => setNum(s.roughen, 'seed', e.target.value, 0, 999, true)} />
            </div>
          </div>
        {/if}

        {#if effectsSubTab.id === 'mask'}
          <div class="switch-row">
            <button
              type="button"
              class="switch"
              class:on={s.clip.on}
              role="switch"
              aria-checked={s.clip.on}
              aria-label="Mask"
              onclick={() => {
                s.clip.on = !s.clip.on;
                if (!s.clip.on && maskTool.id !== null) setMaskTool(maskTool.id);
                touch();
              }}
            ><span class="knob"></span></button>
            <span class="lbl2">Mask</span>
          </div>
          <div class="insp-sub-body" class:disabled={!s.clip.on} style="padding:0;border:none;gap:11px">
            <div class="seg">
              <button
                type="button"
                class:on={s.clip.mode === 'exclude'}
                aria-pressed={s.clip.mode === 'exclude'}
                title="Shapes hide the text under them"
                onclick={() => { s.clip.mode = 'exclude'; touch(); }}
              >Exclude</button>
              <button
                type="button"
                class:on={s.clip.mode === 'include'}
                aria-pressed={s.clip.mode === 'include'}
                title="Only text under the shapes stays visible"
                onclick={() => { s.clip.mode = 'include'; touch(); }}
              >Include</button>
            </div>
            <div class="seg">
              <button
                type="button"
                class:on={maskTool.id === 'brush'}
                aria-pressed={maskTool.id === 'brush'}
                onclick={() => { if (!s.clip.on) return; setMaskTool('brush'); }}
              >Brush</button>
              <button
                type="button"
                class:on={maskTool.id === 'poly'}
                aria-pressed={maskTool.id === 'poly'}
                onclick={() => { if (!s.clip.on) return; setMaskTool('poly'); }}
              >Polygon</button>
              <button
                type="button"
                class:on={maskTool.id === 'ellipse'}
                aria-pressed={maskTool.id === 'ellipse'}
                onclick={() => { if (!s.clip.on) return; setMaskTool('ellipse'); }}
              >Ellipse</button>
            </div>
            <div class="grp">
              <span class="lbl">Brush size</span>
              <div class="slider-row">
                <input type="range" min="2" max="200" step="1" value={s.clip.brushSize} disabled={!s.clip.on} aria-label="Brush size" oninput={(e) => setNum(s.clip, 'brushSize', e.target.value, 2, 200, true)} />
                <input class="num-s" type="number" min="2" max="200" step="1" value={s.clip.brushSize} disabled={!s.clip.on} title="Brush size, page px" aria-label="Brush size, page px" onchange={(e) => commitNum(s.clip, 'brushSize', e, 2, 200, true)} />
              </div>
            </div>
            <div class="insp-none">Draw on the box: brush drags, polygon clicks corner points (double-click closes, Esc cancels), ellipse drags a bounds box. Shapes hide or keep the text per the mode.</div>
            <div class="mask-row">
              <span class="mask-count">{s.clip.shapes.length} shape(s)</span>
              <button
                type="button"
                class="rbtn"
                disabled={!s.clip.shapes.length}
                onclick={() => {
                  if (!s.clip.shapes.length) return;
                  s.clip.shapes = [];
                  touch();
                }}
              >Clear shapes</button>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- ===== Layout ===== -->
    {#if tab === 'layout'}
      <div class="insp-pane" role="tabpanel" id="insp-pane-layout" aria-labelledby="insp-tab-layout">
        {@render secHead('Place')}
        <div class="row2">
          <div class="field"><label class="lbl" for="insp-x">X</label><input id="insp-x" type="number" min="-20000" max="20000" step="1" value={Math.round(box.x)} title="Left edge, page px" onchange={(e) => commitGeom('x', e, -20000, 20000)} /></div>
          <div class="field"><label class="lbl" for="insp-y">Y</label><input id="insp-y" type="number" min="-20000" max="20000" step="1" value={Math.round(box.y)} title="Top edge, page px" onchange={(e) => commitGeom('y', e, -20000, 20000)} /></div>
        </div>
        <div class="row2">
          <div class="field"><label class="lbl" for="insp-w">Width</label><input id="insp-w" type="number" min="30" max="5000" step="1" value={Math.round(box.w)} title="Width, page px" onchange={(e) => commitGeom('w', e, 30, 5000, 40)} /></div>
          <!-- Auto height is a global default now (Settings › Typesetting), with
               the per-box override in the Bulk style panel. The field still has
               to say why it is dead, so the tooltip names where the switch went. -->
          <div class="field"><label class="lbl" for="insp-h">Height</label><input id="insp-h" type="number" min="30" max="5000" step="1" value={Math.round(box.h)} disabled={s.autoHeight} title={s.autoHeight ? 'Auto height is on - the box sizes itself to its text. Set it in Settings › Typesetting' : 'Height, page px'} onchange={(e) => commitGeom('h', e, 30, 5000, 30)} /></div>
        </div>
        <div class="row2">
          <div class="field">
            <span class="lbl">Mirror</span>
            <div class="seg">
              <button type="button" class:on={s.flipH} aria-pressed={s.flipH} title="Flip horizontal (mirror left↔right)" onclick={() => { s.flipH = !s.flipH; touch(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v18" stroke-dasharray="2 2" /><path d="M9 8l-5 4 5 4z" /><path d="M15 8l5 4-5 4z" /></svg>
              </button>
              <button type="button" class:on={s.flipV} aria-pressed={s.flipV} title="Flip vertical (mirror top↔bottom)" onclick={() => { s.flipV = !s.flipV; touch(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12h18" stroke-dasharray="2 2" /><path d="M8 9l4-5 4 5z" /><path d="M8 15l4 5 4-5z" /></svg>
              </button>
            </div>
          </div>
          <div></div>
        </div>

        <div class="insp-rule"></div>

        {@render secHead('Type')}
        <div class="row2">
          <div class="field">
            <span class="lbl">Align</span>
            <div class="seg">
              {#each ['left', 'center', 'right'] as al (al)}
                <button type="button" class:on={s.align === al} aria-pressed={s.align === al} title={al} onclick={() => { s.align = al; touch(); }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">{#each alignIcons[al] as d}<path {d} />{/each}</svg>
                </button>
              {/each}
            </div>
          </div>
          <div class="field">
            <span class="lbl">Vertical</span>
            <div class="seg">
              {#each ['top', 'middle', 'bottom'] as va (va)}
                <button type="button" class:on={s.valign === va} aria-pressed={s.valign === va} title={va} onclick={() => { s.valign = va; touch(); }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">{#each valignIcons[va] as d}<path {d} />{/each}</svg>
                </button>
              {/each}
            </div>
          </div>
        </div>
        <!-- Line height and letter spacing get a row of their own. Nested two
             columns deep they were ~60px wide, which is a number field with no
             room left for its stepper. -->
        <div class="row2">
          <div class="field">
            <label class="lbl" for="insp-lh">Line height</label>
            <input id="insp-lh" type="number" min="0.6" max="3" step="0.05" value={s.lineHeight} title="Line height" oninput={(e) => setNum(s, 'lineHeight', e.target.value || 1, 0.6, 3)} />
          </div>
          <div class="field">
            <label class="lbl" for="insp-ls">Letter spacing</label>
            <input id="insp-ls" type="number" min="-5" max="40" step="0.5" value={s.letterSpacing} title="Extra space between letters, page px" onchange={(e) => commitNum(s, 'letterSpacing', e, -5, 40)} />
          </div>
        </div>

        <div class="insp-rule"></div>

        <!-- Presets: the fastest way to get a box right is to not set it up at
             all. They live beside layout because that is where you reach for
             them, but they reach far past layout - so the section says what
             applying one replaces. -->
        {@render secHead('Preset')}
        <div class="grp">
          <div class="preset-row">
            {#if naming}
              <input
                bind:this={presetNameEl}
                bind:value={presetName}
                placeholder="Preset name"
                aria-label="Preset name"
                onkeydown={onPresetNameKey}
              />
              <button type="button" class="rbtn" title="Save the preset under this name" disabled={!presetName.trim()} onclick={confirmSavePreset}>Save</button>
              <button type="button" class="rbtn" title="Back without saving" onclick={cancelSavePreset}>Cancel</button>
            {:else}
              <select id="insp-preset" value={presetId} onchange={(e) => applyPreset(e.target.value)} aria-label="Preset">
                <option value="">{presets.list.length ? 'Choose…' : 'No presets yet'}</option>
                {#each presets.list as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
              </select>
              <button type="button" class="rbtn" title="Save this box's style as a preset" onclick={startSavePreset}>Save</button>
              <button type="button" class="rbtn" class:arm={delArm} title={delArm ? 'Click again to delete this preset' : 'Delete the selected preset'} disabled={!presetId} onclick={onDeletePreset}>{delArm ? 'Sure?' : 'Delete'}</button>
            {/if}
          </div>
          <div class="insp-none">Replaces colour, effects and type settings</div>
        </div>

        <!-- ===== Typeset (beta) =====
             Only exists while the beta is switched on in Settings. With it off
             the layout engine ignores this box's fit anyway.

             What is left here is the one contextual thing: which balloon THIS
             box was measured against, and the verb that measures it again. The
             switches that used to sit above it - shaped breaks, hyphenation,
             balloon layout, the orphan threshold - are defaults now, set once in
             Settings › Typesetting, and overridable per box from the Bulk style
             panel. None of them said anything about the box you had selected. -->
        {#if prefs.typeset}
          <div class="insp-rule"></div>
          {@render secHead('Typeset · beta')}
          <div class="grp">
            <span class="lbl">{box.fit ? (box.fit.kind === 'ellipse' ? 'Fitted · oval balloon' : 'Fitted · rectangular panel') : 'Not fitted · rectangular layout'}</span>
            <!-- A verb, not a segment: it sat alone in a shell that implies
                 mutually exclusive choices it has none of. -->
            <button type="button" class="rbtn" title="Measure the balloon under this box again, from where the box is now" onclick={() => refitBalloon(box.id)}>
              {box.fit ? 'Re-fit to balloon' : 'Fit to balloon'}
            </button>
          </div>
        {/if}
      </div>
    {/if}

    <button class="btn-danger" onclick={onDeleteBox}>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
      Delete box
    </button>
  </div>
{/if}

<style>
  /* The tab strip. It sticks to the top of the panel's own scroll, because the
      panel is a floating window a letterer resizes down to a few rows: a tab bar
      that scrolls away is a tab bar you cannot reach without scrolling back.
      Each column keeps a minimum width, so the labels stay readable however
      narrow the panel is gripped - past that the strip scrolls sideways rather
      than crushing four words into nothing. */
  .insp-tabs {
    position: sticky;
    top: -12px;
    z-index: 2;
    display: grid;
    grid-template-columns: repeat(4, minmax(52px, 1fr));
    gap: 4px;
    margin: -12px -12px 2px;
    padding: 12px 12px 8px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
  }
  .insp-tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    height: 46px;
    padding: 0 2px;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: var(--t2);
    font-family: inherit;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    cursor: pointer;
    min-width: 0;
  }
  /* The icons arrive as markup, so they carry no scope class of their own. */
  .insp-tab :global(svg) {
    width: 18px;
    height: 18px;
  }
  .insp-tab span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .insp-tab:hover {
    color: var(--text);
    background: var(--surface);
  }
  .insp-tab.on {
    color: var(--accent-fg);
    background: var(--accent);
    border-color: var(--accent);
  }
  .insp-tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  /* `.insp-pane` and `.slider-row .num-s` moved to styles.css - the brush panel
     is a pane with slider rows of its own, and Svelte's scoping would have made
     the second component restate them. */

  /* A heading inside a pane, for the two or three blocks a pane still groups. */
  .insp-sec {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--t3);
  }

  /* A label with its own glyph in front of it (rotation). */
  .lbl.ico {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .lbl.ico :global(svg) {
    width: 13px;
    height: 13px;
  }

  /* Size beside the weight buttons: the menu takes what it needs, the three
     letters take the rest. */
  .row-size {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .row-size > * {
    min-width: 0;
  }

  /* Gradient type: an icon over its name, two up. */
  .kbtn {
    flex-direction: column;
    gap: 2px;
    height: 46px;
    font-size: 10px;
  }
  .kbtn :global(svg) {
    width: 17px;
    height: 17px;
  }

  /* The stop bar: the ramp at the size a decision needs, and a rail of handles
     under it. The two are one control - the wrapper takes the pointerdown that
     adds a stop, so clicking either the ramp or the empty rail beside a handle
     puts a new one where it was clicked. */
  .grad-edit {
    display: flex;
    flex-direction: column;
    cursor: copy;
    touch-action: none;
  }
  .grad-bar {
    position: relative;
    height: 34px;
    border-radius: 7px 7px 0 0;
    border: 1px solid var(--line2);
    border-bottom: none;
    overflow: hidden;
    /* The chequerboard a stop's alpha is read against: without something
       underneath it, a transparent stop is the panel's own background and
       reads as a colour rather than as a hole. */
    background-color: #fff;
    background-image:
      linear-gradient(45deg, #c9c9c9 25%, transparent 25%),
      linear-gradient(-45deg, #c9c9c9 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #c9c9c9 75%),
      linear-gradient(-45deg, transparent 75%, #c9c9c9 75%);
    background-size: 10px 10px;
    background-position: 0 0, 0 5px, 5px -5px, -5px 0;
  }
  .grad-ramp {
    position: absolute;
    inset: 0;
    background-size: cover;
  }
  /* The rail's PADDING box is the ramp's box exactly - same 1px side borders,
     no margin - because a handle's `left` is its position along the gradient
     and the two have to be the same ruler. */
  .grad-rail {
    position: relative;
    height: 15px;
    border-radius: 0 0 7px 7px;
    background: var(--surface);
    border: 1px solid var(--line2);
    border-top: none;
  }
  /* A house: flat-bottomed, pointed at the ramp it marks. The point IS the
     position, so the chip is centred on its own left edge. */
  .gstop {
    position: absolute;
    top: -1px;
    width: 13px;
    height: 15px;
    margin-left: -6.5px;
    padding: 0;
    border: none;
    background: var(--stop-c, #000);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.45);
    clip-path: polygon(50% 0, 100% 40%, 100% 100%, 0 100%, 0 40%);
    cursor: ew-resize;
    touch-action: none;
  }
  .gstop:hover {
    box-shadow: inset 0 0 0 1px var(--text);
  }
  .gstop.on,
  .gstop:focus-visible {
    outline: none;
    box-shadow:
      inset 0 0 0 1px var(--accent-fg),
      inset 0 0 0 3px var(--accent);
  }

  /* The selected stop's own row, on the same column widths as the caption
      above it: index, swatch, hex, position, opacity, add, bin. */
  .grad-sel,
  .grad-cap {
    display: grid;
    grid-template-columns: 22px 24px minmax(0, 1fr) 46px 46px 20px 20px;
    gap: 6px;
    align-items: center;
  }
  .grad-cap {
    margin-top: 8px;
  }
  .grad-sel {
    margin-top: 2px;
  }
  /* The same stripped number field the list rows use: at 46px a spinner costs
     the column the third digit of "100". */
  .grad-sel input[type='number'] {
    padding: 0 5px;
    -moz-appearance: textfield;
  }
  .grad-sel input[type='number']::-webkit-inner-spin-button,
  .grad-sel input[type='number']::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .grad-n {
    font-size: 10px;
    color: var(--t3);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  /* The direction pad: nine cells, and a cell's POSITION is the direction it
     sets. The number beside it is the same field, for the angles between. */
  .pad-row {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    min-width: 0;
  }
  .dirpad {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: repeat(3, 32px);
    grid-auto-rows: 32px;
    gap: 3px;
  }
  .pad-side {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .pad-side .field {
    gap: 6px;
  }
  .dirpad .cell {
    display: grid;
    place-items: center;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--surface);
    color: var(--t2);
    padding: 0;
    cursor: pointer;
    font-size: 9px;
    font-family: inherit;
    font-variant-numeric: tabular-nums;
  }
  .dirpad .cell.blank,
  .dirpad .cell.mid {
    border-color: transparent;
    background: transparent;
    color: var(--t3);
    cursor: default;
  }
  button.cell:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  button.cell.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg);
  }
  .dirpad .arrow {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
  }
  .dirpad .arrow :global(svg) {
    width: 16px;
    height: 16px;
  }
  /* The centre presets say where the middle of the circle goes, so the dot is
     the whole picture. */
  .dirpad .cdot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }

  /* Patterns as cards. Nobody knows what "grid" looks like from the word; the
     tile is drawn by the same painter that paints the glyphs, in this box's own
     two colours, so the card IS the answer. */
  .pat-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
  }
  .pat-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px 4px 5px;
    border: 1px solid var(--line2);
    border-radius: 7px;
    background: var(--surface);
    color: var(--t2);
    font-family: inherit;
    cursor: pointer;
    min-width: 0;
  }
  .pat-card:hover {
    border-color: var(--accent);
    color: var(--text);
  }
  .pat-card.on {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
    color: var(--text);
  }
  .pat-tile {
    height: 30px;
    border-radius: 4px;
    background-repeat: repeat;
    background-position: center;
    border: 1px solid var(--line);
  }
  .pat-name {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The inline preset name field takes the room the menu takes, and the armed
     delete reads as the warning it is. */
  .preset-row input {
    flex: 1 1 auto;
    min-width: 0;
    width: auto;
  }
  .preset-row .rbtn.arm {
    color: var(--warn);
    border-color: var(--warn);
  }

  .sub-tabs {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 3px;
  }
  .sub-tab {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 24px;
    padding: 0 2px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--t2);
    cursor: pointer;
    min-width: 0;
  }
  .sub-tab :global(svg) {
    width: 15px;
    height: 15px;
  }
  .sub-tab:hover {
    color: var(--text);
    background: var(--surface);
  }
  .sub-tab.on {
    color: var(--accent-fg);
    background: var(--accent);
    border-color: var(--accent);
  }
  .sub-tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .mask-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .mask-count {
    font-size: 11.5px;
    color: var(--t3);
  }
</style>
